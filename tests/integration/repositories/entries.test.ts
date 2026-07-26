import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CategoryRepository } from '../../../app/repositories/categoryRepository.js';
import { EntryRepository } from '../../../app/repositories/entryRepository.js';
import { createTestDb, type TestDb } from '../../helpers/testDb.js';

let db: TestDb;
let entries: EntryRepository;
let categories: CategoryRepository;

beforeAll(async () => {
  db = await createTestDb();
  entries = new EntryRepository(db.manager);
  categories = new CategoryRepository(db.manager);
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.reset();
  await categories.ensureMany(['Sword', 'Axe', 'Crystal']);
});

const baseEntry = {
  player: 'Alice',
  rank: 'Master',
  points: 900,
  testServer: null,
  tiers: {} as Record<string, string>
};

describe('EntryRepository', () => {
  it('创建时写入定级，读回时按项目名组装', async () => {
    const created = await entries.create({
      ...baseEntry,
      tiers: { Sword: 'HT1', Axe: 'LT2' }
    });

    const found = await entries.findById(created.id);
    expect(found?.tiers).toEqual({ Sword: 'HT1', Axe: 'LT2' });
    // 领域字段名是 rank，存储列名是 rank_label（避开保留字）
    expect(found?.rank).toBe('Master');
  });

  /*
   * create() 必须回读，不能把入参原样返回。#writeTiers 会静默跳过查不到对应
   * 项目的名字（项目可能刚被删掉），返回入参就等于宣称写进去了一份并不存在的
   * 定级——而 update() 一直是回读的，两者语义必须一致。
   */
  it('创建的返回值只含真正落库的定级', async () => {
    const created = await entries.create({
      ...baseEntry,
      tiers: { Sword: 'HT1', NotACategory: 'HT9' }
    });

    expect(created.tiers).toEqual({ Sword: 'HT1' });
    expect(created.tiers).toEqual((await entries.findById(created.id))?.tiers);
  });

  it('未定级的项目不出现在 tiers 里（不是 null 而是缺失）', async () => {
    const created = await entries.create({ ...baseEntry, tiers: { Sword: 'HT1' } });
    const found = await entries.findById(created.id);

    expect(found?.tiers).toEqual({ Sword: 'HT1' });
    expect('Axe' in (found?.tiers ?? {})).toBe(false);
  });

  it('listWithTiers 一次读回所有条目及其定级', async () => {
    await entries.create({ ...baseEntry, tiers: { Sword: 'HT1' } });
    await entries.create({ ...baseEntry, player: 'Bob', tiers: { Crystal: 'LT4' } });
    await entries.create({ ...baseEntry, player: 'Carol' });

    const all = await entries.listWithTiers();
    expect(all).toHaveLength(3);
    expect(all.find((e) => e.player === 'Bob')?.tiers).toEqual({ Crystal: 'LT4' });
    expect(all.find((e) => e.player === 'Carol')?.tiers).toEqual({});
  });

  it('玩家名查找不区分大小写', async () => {
    await entries.create(baseEntry);
    expect((await entries.findByPlayer('alice'))?.player).toBe('Alice');
    expect((await entries.findByPlayer('ALICE'))?.player).toBe('Alice');
    expect(await entries.findByPlayer('nobody')).toBeNull();
  });

  it('快速编辑只改指定字段，定级原样保留', async () => {
    const created = await entries.create({
      ...baseEntry,
      tiers: { Sword: 'HT1', Axe: 'LT2' }
    });

    const updated = await entries.quickUpdate(created.id, { points: 1500 });

    expect(updated.points).toBe(1500);
    expect(updated.rank).toBe('Master');
    expect(updated.tiers).toEqual({ Sword: 'HT1', Axe: 'LT2' });
  });

  it('快速编辑可把测试服清空', async () => {
    const created = await entries.create({ ...baseEntry, testServer: 'Pico Test #3' });
    const updated = await entries.quickUpdate(created.id, { testServer: null });
    expect(updated.testServer).toBeNull();
  });

  it('全量更新会整体替换定级', async () => {
    const created = await entries.create({
      ...baseEntry,
      tiers: { Sword: 'HT1', Axe: 'LT2' }
    });

    const updated = await entries.update(created.id, {
      player: 'Alice',
      rank: 'Grandmaster',
      points: 1500,
      testServer: null,
      tiers: { Crystal: 'HT5' }
    });

    expect(updated.tiers).toEqual({ Crystal: 'HT5' });
    expect(updated.rank).toBe('Grandmaster');
  });

  it('删除返回是否命中，不存在时为 false', async () => {
    const created = await entries.create(baseEntry);
    // 旧实现无论目标是否存在都报成功
    expect(await entries.delete('entry-does-not-exist')).toBe(false);
    expect(await entries.delete(created.id)).toBe(true);
    expect(await entries.findById(created.id)).toBeNull();
  });

  it('无法解析的 tier 值也照常存取（历史数据里确实存在）', async () => {
    const created = await entries.create({ ...baseEntry, tiers: { Sword: '不合法' } });
    expect((await entries.findById(created.id))?.tiers).toEqual({ Sword: '不合法' });
  });
});

describe('CategoryRepository', () => {
  it('名字列表按字母序返回（公开 API 契约的一部分）', async () => {
    expect(await categories.listNames()).toEqual(['Axe', 'Crystal', 'Sword']);
  });

  it('按名字查找不区分大小写', async () => {
    expect((await categories.findByName('sword'))?.name).toBe('Sword');
    expect((await categories.findByName('SWORD'))?.name).toBe('Sword');
    expect(await categories.findByName('bow')).toBeNull();
  });

  it('ensureMany 幂等：已存在的不重复创建', async () => {
    const again = await categories.ensureMany(['Sword', 'Bow']);
    expect(await categories.listNames()).toEqual(['Axe', 'Bow', 'Crystal', 'Sword']);
    expect(again.get('Sword')).toBe((await categories.findByName('Sword'))?.id);
  });

  it('改名后旧名字查不到，条目上的定级仍在（靠 id 关联）', async () => {
    const sword = (await categories.findByName('Sword'))!;
    const entry = await entries.create({ ...baseEntry, tiers: { Sword: 'HT1' } });

    await categories.rename(sword.id, 'Sword PvP');

    expect(await categories.findByName('Sword')).toBeNull();
    // 旧实现的改名要遍历全表改 JSON；这里只动一行，定级自动跟随
    expect((await entries.findById(entry.id))?.tiers).toEqual({ 'Sword PvP': 'HT1' });
  });

  it('删除项目会级联清掉相关定级', async () => {
    const sword = (await categories.findByName('Sword'))!;
    const entry = await entries.create({
      ...baseEntry,
      tiers: { Sword: 'HT1', Axe: 'LT2' }
    });

    expect(await categories.delete(sword.id)).toBe(true);

    expect((await entries.findById(entry.id))?.tiers).toEqual({ Axe: 'LT2' });
    expect(await categories.delete(sword.id)).toBe(false);
  });
});
