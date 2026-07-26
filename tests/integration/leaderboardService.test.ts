import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../../app/errors/AppError.js';
import { UTF8_BOM } from '../../app/utils/csv.js';
import { createServices, type TestServices } from '../helpers/services.js';
import { createTestDb, type TestDb } from '../helpers/testDb.js';

let db: TestDb;
let s: TestServices;

beforeAll(async () => {
  db = await createTestDb();
  s = createServices(db);
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.reset();
  await s.categories.ensureMany(['Axe', 'Sword']);
});

async function expectAppError(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(AppError.is(error)).toBe(true);
    expect((error as AppError).code).toBe(code);
    return;
  }
  throw new Error(`预期抛出 ${code}，但没有抛出`);
}

async function seedEntries(): Promise<void> {
  await s.entries.create({
    player: 'Carol',
    rank: 'Grandmaster',
    points: 1200,
    testServer: null,
    tiers: { Sword: 'HT1' }
  });
  await s.entries.create({
    player: 'Alice',
    rank: 'Master',
    points: 900,
    testServer: 'Pico Test #3',
    tiers: { Sword: 'LT3', Axe: 'HT2' }
  });
  await s.entries.create({
    player: 'Bob',
    rank: 'Ace',
    points: 900,
    testServer: null,
    tiers: {}
  });
}

describe('LeaderboardService · 读取', () => {
  it('名次在读取时计算，同分共享并跳号', async () => {
    await seedEntries();
    const ranked = await s.leaderboard.listRanked();

    expect(ranked.map((entry) => `${entry.player}#${String(entry.position)}`)).toEqual([
      'Carol#1',
      'Alice#2',
      'Bob#2'
    ]);
  });

  it('默认排序为名次升序', async () => {
    await seedEntries();
    const sorted = await s.leaderboard.listSorted();
    expect(sorted.map((e) => e.player)).toEqual(['Carol', 'Alice', 'Bob']);
  });

  it('可按玩家名与积分排序，支持升降序', async () => {
    await seedEntries();

    expect((await s.leaderboard.listSorted('player', 'asc')).map((e) => e.player)).toEqual([
      'Alice',
      'Bob',
      'Carol'
    ]);
    expect((await s.leaderboard.listSorted('player', 'desc')).map((e) => e.player)).toEqual([
      'Carol',
      'Bob',
      'Alice'
    ]);
    expect((await s.leaderboard.listSorted('points', 'asc'))[0]?.points).toBe(900);
    expect((await s.leaderboard.listSorted('points', 'desc'))[0]?.points).toBe(1200);
  });

  it('排序不改变名次本身（名次始终由积分决定）', async () => {
    await seedEntries();
    const byName = await s.leaderboard.listSorted('player', 'asc');
    expect(byName.find((e) => e.player === 'Carol')?.position).toBe(1);
    expect(byName.find((e) => e.player === 'Bob')?.position).toBe(2);
  });

  it('搜索覆盖玩家名、段位、测试服与细分项目', async () => {
    await seedEntries();

    expect((await s.leaderboard.search('ali')).map((e) => e.player)).toEqual(['Alice']);
    expect((await s.leaderboard.search('MASTER')).map((e) => e.player)).toEqual(['Carol', 'Alice']);
    expect((await s.leaderboard.search('pico')).map((e) => e.player)).toEqual(['Alice']);
    expect((await s.leaderboard.search('HT1')).map((e) => e.player)).toEqual(['Carol']);
    // 空查询返回全部
    expect(await s.leaderboard.search('  ')).toHaveLength(3);
    expect(await s.leaderboard.search('没有这个人')).toHaveLength(0);
  });

  it('分页把越界页码收敛到有效范围', async () => {
    await seedEntries();

    const first = await s.leaderboard.listPaged(1, 2);
    expect(first.items.map((e) => e.player)).toEqual(['Carol', 'Alice']);
    expect(first).toMatchObject({ page: 1, total: 3, totalPages: 2 });

    expect((await s.leaderboard.listPaged(99, 2)).page).toBe(2);
    expect((await s.leaderboard.listPaged(0, 2)).page).toBe(1);
    expect((await s.leaderboard.listPaged(-5, 2)).page).toBe(1);
  });

  it('空榜单的分页仍返回第 1 页', async () => {
    const page = await s.leaderboard.listPaged(1, 20);
    expect(page).toMatchObject({ items: [], page: 1, total: 0, totalPages: 1 });
  });

  it('统计条目数与项目数', async () => {
    await seedEntries();
    expect(await s.leaderboard.stats()).toEqual({ entries: 3, categories: 2 });
  });
});

describe('LeaderboardService · 写入', () => {
  it('更新不存在的条目报 entry_not_found', async () => {
    await expectAppError(s.leaderboard.quickUpdate('entry-nope', { points: 1 }), 'entry_not_found');
    await expectAppError(
      s.leaderboard.update('entry-nope', {
        player: 'X',
        rank: 'Y',
        points: 0,
        testServer: null,
        tiers: {}
      }),
      'entry_not_found'
    );
  });

  it('删除不存在的条目报错，而不是假装成功', async () => {
    // 旧实现无论目标是否存在都返回 success=deleted
    await expectAppError(s.leaderboard.delete('entry-nope'), 'entry_not_found');
  });

  it('删除存在的条目正常完成', async () => {
    const entry = await s.entries.create({
      player: 'Temp',
      rank: 'X',
      points: 1,
      testServer: null,
      tiers: {}
    });
    await expect(s.leaderboard.delete(entry.id)).resolves.toBeUndefined();
    expect(await s.entries.count()).toBe(0);
  });
});

describe('LeaderboardService · CSV 导出', () => {
  it('带 UTF-8 BOM，否则 Excel 会把中文读成乱码', async () => {
    await seedEntries();
    const csv = await s.leaderboard.exportCsv();
    expect(csv.startsWith(UTF8_BOM)).toBe(true);
  });

  it('表头包含固定列与全部细分项目，行按名次排列', async () => {
    await seedEntries();
    const lines = (await s.leaderboard.exportCsv()).slice(UTF8_BOM.length).split('\r\n');

    expect(lines[0]).toBe('position,player,rank,points,testServer,Axe,Sword');
    expect(lines[1]).toBe('1,Carol,Grandmaster,1200,,,HT1');
    expect(lines[2]).toBe('2,Alice,Master,900,Pico Test #3,HT2,LT3');
    // 未定级留空
    expect(lines[3]).toBe('2,Bob,Ace,900,,,');
  });

  it('含逗号或引号的字段被正确转义', async () => {
    await s.entries.create({
      player: 'Weird"Name',
      rank: 'A,B',
      points: 5,
      testServer: 'line\nbreak',
      tiers: {}
    });

    const csv = await s.leaderboard.exportCsv();
    expect(csv).toContain('"Weird""Name"');
    expect(csv).toContain('"A,B"');
    expect(csv).toContain('"line\nbreak"');
  });

  it('用 CRLF 行尾（Excel 的期望）', async () => {
    await seedEntries();
    expect((await s.leaderboard.exportCsv()).includes('\r\n')).toBe(true);
  });
});

describe('CategoryService', () => {
  it('新增项目，重复名字（含大小写变体）被拒绝', async () => {
    await s.categoryService.add('Bow');
    expect(await s.categoryService.listNames()).toEqual(['Axe', 'Bow', 'Sword']);

    await expectAppError(s.categoryService.add('bow'), 'category_exists');
    await expectAppError(s.categoryService.add('BOW'), 'category_exists');
  });

  it('改名后条目上的定级自动跟随（靠 id 关联）', async () => {
    const entry = await s.entries.create({
      player: 'P',
      rank: 'R',
      points: 1,
      testServer: null,
      tiers: { Sword: 'HT1' }
    });

    await s.categoryService.rename('Sword', 'Sword PvP');

    expect((await s.entries.findById(entry.id))?.tiers).toEqual({ 'Sword PvP': 'HT1' });
  });

  it('改成自身的大小写变体是允许的', async () => {
    await expect(s.categoryService.rename('Sword', 'SWORD')).resolves.toBeUndefined();
    expect(await s.categoryService.listNames()).toContain('SWORD');
  });

  it('改名到已被占用的名字被拒绝', async () => {
    await expectAppError(s.categoryService.rename('Sword', 'Axe'), 'category_exists');
  });

  it('操作不存在的项目报 category_not_found', async () => {
    await expectAppError(s.categoryService.rename('Nope', 'X'), 'category_not_found');
    await expectAppError(s.categoryService.remove('Nope'), 'category_not_found');
  });

  it('删除项目会级联清掉相关定级', async () => {
    const entry = await s.entries.create({
      player: 'P',
      rank: 'R',
      points: 1,
      testServer: null,
      tiers: { Sword: 'HT1', Axe: 'LT2' }
    });

    await s.categoryService.remove('Sword');

    expect(await s.categoryService.listNames()).toEqual(['Axe']);
    expect((await s.entries.findById(entry.id))?.tiers).toEqual({ Axe: 'LT2' });
  });

  it('resolveIds 按名字解析（大小写不敏感），未知名字被忽略', async () => {
    const resolved = await s.categoryService.resolveIds(['sword', 'AXE', 'Unknown']);
    expect([...resolved.keys()]).toEqual(['sword', 'AXE']);
  });
});
