import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CategoryRepository } from '../../app/repositories/categoryRepository.js';
import { EntryRepository } from '../../app/repositories/entryRepository.js';
import { SettingsRepository } from '../../app/repositories/settingsRepository.js';
import { UserRepository } from '../../app/repositories/userRepository.js';
import {
  findConflicts,
  findOversized,
  importLegacyData,
  normalizeRole,
  type ImportReport,
  type LegacyData,
  type LegacyEntry,
  type LegacySettings,
  type LegacyUser
} from '../../scripts/lib/legacyImport.js';
import { createTestDb, testDbConfig, type TestDb } from '../helpers/testDb.js';

const FIXTURE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures/legacy');

let db: TestDb;
let users: UserRepository;
let entries: EntryRepository;
let categories: CategoryRepository;
let settings: SettingsRepository;
let fixture: LegacyData;

async function readFixture<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(resolve(FIXTURE_DIR, name), 'utf-8')) as T;
}

/** 在事务里跑导入。Kysely 的事务无法手动提交，直接让它正常结束即为提交。 */
async function runImport(data: LegacyData = fixture): Promise<ImportReport> {
  let report: ImportReport | undefined;
  await db.manager
    .db()
    .transaction()
    .execute(async (trx) => {
      report = await importLegacyData(trx, data, 'admin', testDbConfig().driver);
    });
  if (!report) throw new Error('导入未产出报告');
  return report;
}

beforeAll(async () => {
  db = await createTestDb();
  users = new UserRepository(db.manager);
  entries = new EntryRepository(db.manager);
  categories = new CategoryRepository(db.manager);
  settings = new SettingsRepository(db.manager);

  fixture = {
    users: await readFixture<LegacyUser[]>('users.json'),
    entries: await readFixture<LegacyEntry[]>('leaderboard.json'),
    settings: await readFixture<LegacySettings>('settings.json')
  };
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.reset();
});

describe('findConflicts', () => {
  it('检出只差大小写的重复用户名', () => {
    const conflicts = findConflicts([
      { id: 'a', username: 'Player' },
      { id: 'b', username: 'player' }
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ kind: 'username', value: 'player' });
    expect(conflicts[0]?.ids).toEqual(['a', 'b']);
  });

  it('检出只差大小写的重复邮箱', () => {
    const conflicts = findConflicts([
      { id: 'a', username: 'x', email: 'A@B.com' },
      { id: 'b', username: 'y', email: 'a@b.com' }
    ]);
    expect(conflicts.some((c) => c.kind === 'email')).toBe(true);
  });

  it('无冲突时返回空数组', () => {
    expect(findConflicts(fixture.users)).toEqual([]);
  });
});

/*
 * 长度检查必须在导入之前跑。
 *
 * migrate-json 的目标固定是 SQLite，而 SQLite 不强制 varchar(n)：不拦的话
 * 报告一片绿、导入成功，直到日后用面板 migrate 到 PostgreSQL / MySQL 时才在
 * 复制事务里炸，那时错误来自驱动层，指不出是哪一行、更指不出是旧数据的问题。
 * 超长值在旧数据里是真实存在的——旧站的 Excel 导入直接拿表头当项目名。
 */
describe('findOversized', () => {
  it('检出超出列宽的用户名与邮箱', () => {
    const found = findOversized({
      users: [{ id: 'a', username: 'x'.repeat(33), email: `${'y'.repeat(250)}@example.com` }],
      entries: [],
      settings: {}
    });

    expect(found.map((item) => item.field).sort()).toEqual(['email', 'username']);
    expect(found[0]).toMatchObject({ limit: 32, actual: 33 });
  });

  it('检出超长的项目名与定级（旧站 Excel 导入的产物）', () => {
    const found = findOversized({
      users: [],
      entries: [
        {
          id: 'e1',
          player: 'Notch',
          categories: { ['Crystal '.repeat(10)]: 'HT1', Sword: 'X'.repeat(33) }
        }
      ],
      settings: {}
    });

    expect(found).toHaveLength(2);
    expect(found.some((item) => item.field.includes('细分项目名'))).toBe(true);
    expect(found.some((item) => item.field.includes('的定级'))).toBe(true);
  });

  it('恰好等于上限的值不算超长', () => {
    expect(
      findOversized({
        users: [{ id: 'a', username: 'x'.repeat(32) }],
        entries: [{ id: 'e', player: 'p'.repeat(32), rank: 'r'.repeat(64) }],
        settings: {}
      })
    ).toEqual([]);
  });

  it('真实 fixture 不含超长字段', () => {
    expect(findOversized(fixture)).toEqual([]);
  });
});

describe('normalizeRole', () => {
  it('把旧的小写 admin 提升为 SuperAdmin', () => {
    expect(normalizeRole('admin', 'OldAdmin', 'admin')).toBe('SuperAdmin');
  });

  it('env 指定的用户名总是 SuperAdmin', () => {
    expect(normalizeRole('User', 'admin', 'admin')).toBe('SuperAdmin');
  });

  it('无法识别的角色退回 User', () => {
    expect(normalizeRole('moderator', 'x', 'admin')).toBe('User');
    expect(normalizeRole(undefined, 'x', 'admin')).toBe('User');
  });

  it('保留合法角色', () => {
    expect(normalizeRole('Admin', 'x', 'admin')).toBe('Admin');
  });
});

describe('importLegacyData', () => {
  it('导入全部用户，并按旧规则归一角色', async () => {
    const report = await runImport();
    expect(report.users).toBe(5);

    // 旧的小写 'admin' 角色被提升
    expect((await users.findByUsername('OldAdmin'))?.role).toBe('SuperAdmin');
    // 无法识别的 'moderator' 退回 User
    expect((await users.findByUsername('WeirdRole'))?.role).toBe('User');
    expect((await users.findByUsername('admin'))?.role).toBe('SuperAdmin');

    /*
     * 报告必须把 SuperAdmin 列出来。旧规则「role === 'admin' 即 SuperAdmin」
     * 意味着旧数据里有几个这样的账号，导入后就有几个 SuperAdmin；而新站的
     * userService 拒绝对任何 SuperAdmin 降级或删除，多出来的那些在后台里
     * 动不了。这件事必须在切换清单第 3 步就被看到，而不是上线后才发现。
     */
    expect(report.superAdmins).toHaveLength(2);
    expect(report.superAdmins).toContain('admin');
    expect(report.superAdmins).toContain('OldAdmin');
  });

  it('缺失邮箱时补 <username>@local（沿用旧站语义）', async () => {
    await runImport();
    expect((await users.findByUsername('NoMail'))?.email).toBe('NoMail@local');
  });

  it('保留 OAuth 绑定与空密码哈希', async () => {
    await runImport();
    const msUser = await users.findByOauth('microsoft', 'ms-subject-123');
    expect(msUser?.username).toBe('MsUser');
    expect(msUser?.passwordHash).toBeNull();
  });

  it('丢弃验证码与冷却字段（TTL 只有 5 分钟，迁移时必然已过期）', async () => {
    await runImport();
    const msUser = await users.findByUsername('MsUser');
    expect(msUser).not.toBeNull();
    // 新库里这些字段根本不存在于 users 表，验证码表也不该有残留
    const codes = await db.manager.db().selectFrom('verification_codes').selectAll().execute();
    expect(codes).toEqual([]);
  });

  it('细分项目取所有条目 categories 键的并集', async () => {
    const report = await runImport();
    expect(report.categories).toBe(4);
    expect(await categories.listNames()).toEqual(['Axe', 'Crystal', 'Sword', 'Trident Box']);
  });

  /*
   * 下面两条守的是同一类历史数据：旧站的 Excel 导入直接把表头
   * `String(header).trim()` 当项目名，既不校验大小写也不校验字符集。
   * 它们原本都会以主键冲突炸掉整个导入事务——而导入是一次性的、
   * 面向生产数据的操作，中途回滚只会留下一个「跑不通也不知道为什么」的现场。
   */
  it('只差大小写的项目名折叠成同一个项目，条目上的重复键被跳过并记入报告', async () => {
    const data: LegacyData = {
      users: [],
      settings: {},
      entries: [
        { id: 'e1', player: 'Alpha', points: 10, categories: { Crystal: 'HT1' } },
        // 同一个项目的另一种写法：目标库的 name_lower 唯一，只会有一行
        { id: 'e2', player: 'Beta', points: 5, categories: { crystal: 'LT2' } },
        // 同一条目里两种写法都出现——两条 tier 会指向同一个 category_id
        { id: 'e3', player: 'Gamma', points: 1, categories: { Crystal: 'HT2', crystal: 'LT4' } }
      ]
    };

    const report = await runImport(data);

    expect(report.categories).toBe(1);
    expect(await categories.listNames()).toEqual(['Crystal']);
    expect(report.tiers).toBe(3);
    expect(report.skippedRecords.some((line) => line.includes('Gamma'))).toBe(true);
    expect((await entries.findByPlayer('Beta'))?.tiers).toEqual({ Crystal: 'LT2' });
  });

  it('归一后会撞成同一个 slug 的两个项目名各自独立', async () => {
    // 派生 id（名字里非字母数字替换成 `-`）会把这两个折成同一个 `cat-crystal-pvp`
    const data: LegacyData = {
      users: [],
      settings: {},
      entries: [
        { id: 'e1', player: 'Alpha', points: 10, categories: { 'Crystal PvP': 'HT1' } },
        { id: 'e2', player: 'Beta', points: 5, categories: { 'Crystal-PvP': 'LT2' } }
      ]
    };

    const report = await runImport(data);

    expect(report.categories).toBe(2);
    expect(await categories.listNames()).toEqual(['Crystal PvP', 'Crystal-PvP']);
    expect(report.tiers).toBe(2);
  });

  it('null 定级不建行，非 null 的照原样保留', async () => {
    const report = await runImport();
    // Carol: Sword+Axe（Crystal 为 null）= 2；Alice: Sword+Crystal = 2；Bob: 1；Dave: 2
    expect(report.tiers).toBe(7);

    const carol = await entries.findByPlayer('Carol');
    expect(carol?.tiers).toEqual({ Sword: 'HT1', Axe: 'LT2' });
    expect('Crystal' in (carol?.tiers ?? {})).toBe(false);
  });

  it('保留无法解析的 tier 值（历史数据里确实存在）', async () => {
    await runImport();
    const dave = await entries.findByPlayer('Dave');
    expect(dave?.tiers['Sword']).toBe('不合法的段位');
  });

  it('把 testServer 的空字符串归一为 null', async () => {
    await runImport();
    expect((await entries.findByPlayer('Dave'))?.testServer).toBeNull();
    expect((await entries.findByPlayer('Alice'))?.testServer).toBe('Pico Test #3');
  });

  it('不导入 position，改由排名算法在读取时计算', async () => {
    const report = await runImport();
    // 旧文件里 Alice 与 Bob 同为 position 2，新算法必须复现这个结果
    expect(report.rankingSample).toEqual([
      '1. Carol (1200)',
      '2. Alice (900)',
      '2. Bob (900)',
      '4. Dave (0)'
    ]);
  });

  it('导入设置并丢弃旧的 migrations 标志位', async () => {
    await runImport();
    const loaded = await settings.load();
    expect(loaded).toEqual({
      registrationEnabled: true,
      oauthEnabled: true,
      oauthMicrosoft: { clientId: 'fixture-client-id', tenant: 'common' }
    });
  });

  it('重复导入是幂等的：不产生重复行', async () => {
    const first = await runImport();
    const second = await runImport();

    expect(first.categories).toBe(4);
    expect(second.categories).toBe(0);
    expect(await users.count()).toBe(5);
    expect(await entries.count()).toBe(4);
    expect(second.tiers).toBe(7);
    expect((await entries.listWithTiers()).find((e) => e.player === 'Carol')?.tiers).toEqual({
      Sword: 'HT1',
      Axe: 'LT2'
    });
  });

  it('与目标库中同名或同邮箱的既有账号合并，而不是撞唯一约束', async () => {
    // 真实场景：新站先启动过一次，ensureSuperAdmin 已 seed 了 admin
    // （id 是随机 UUID），随后才导入旧数据里 id 为 admin-1 的同一个账号
    const seeded = await users.create({
      username: 'admin',
      email: 'admin@local',
      passwordHash: 'seeded-hash',
      role: 'SuperAdmin',
      emailVerified: true
    });

    const report = await runImport();

    expect(report.usersMerged).toBe(1);
    expect(await users.count()).toBe(5);
    // 保留目标库原有的 id，其余字段来自导入数据
    const merged = await users.findByUsername('admin');
    expect(merged?.id).toBe(seeded.id);
    expect(merged?.passwordHash).not.toBe('seeded-hash');
    expect(await users.findById('admin-1')).toBeNull();
  });

  /*
   * 用户名命中 A、邮箱命中 B 时必须停下来。
   *
   * 取第一条去 update 的话，另一列的唯一约束随后必然冲突、整批回滚，而现场
   * 只留下一条驱动层的约束报错，看不出是哪两个账号在打架。findConflicts 只查
   * 旧数据**内部**的重复，挡不住「旧数据 vs 目标库已有行」这种交叉命中。
   */
  it('同时命中目标库里两个不同账号时，报出三方而不是静默挑一个', async () => {
    await users.create({
      username: 'ClashName',
      email: 'name-owner@example.com',
      passwordHash: 'h',
      role: 'User',
      emailVerified: true
    });
    await users.create({
      username: 'OtherName',
      email: 'mail-owner@example.com',
      passwordHash: 'h',
      role: 'User',
      emailVerified: true
    });

    await expect(
      runImport({
        users: [{ id: 'legacy-1', username: 'clashname', email: 'MAIL-OWNER@example.com' }],
        entries: [],
        settings: {}
      })
    ).rejects.toThrow(/同时对应目标库里的多个既有账号/);
  });

  it('id 相同的记录按 id 更新，不计入合并数', async () => {
    await runImport();
    const second = await runImport();
    expect(second.usersMerged).toBe(0);
    expect(await users.count()).toBe(5);
  });

  it('跳过缺少用户名或玩家名的记录并记入报告', async () => {
    const report = await runImport({
      users: [{ id: 'broken' }],
      entries: [{ id: 'broken-entry', points: 5 }],
      settings: {}
    });
    expect(report.users).toBe(0);
    expect(report.entries).toBe(0);
    expect(report.skippedRecords).toHaveLength(2);
  });

  it('空数据集也能正常完成', async () => {
    const report = await runImport({ users: [], entries: [], settings: {} });
    expect(report.users).toBe(0);
    expect(report.entries).toBe(0);
    expect(report.settings).toBe(3);
  });
});
