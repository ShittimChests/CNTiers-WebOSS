/**
 * 旧 JSON 数据 → 数据库的导入逻辑。
 *
 * 与 CLI（scripts/migrate-json.ts）分离，好处是这段决定生产数据命运的代码
 * 可以被测试直接调用，而不必去驱动一个进程。M8 删除旧站时本文件一并删除。
 */
import { randomUUID } from 'node:crypto';
import type { Transaction } from 'kysely';
import { ROLES, type Role } from '../../app/config/constants.js';
import type { DbDriver } from '../../app/db/dialects.js';
import type { Database } from '../../app/db/types.js';
import { upsertRow } from '../../app/db/upsert.js';
import { rankEntries } from '../../app/utils/ranking.js';

// ---------- 旧数据形状（宽松：历史记录可能缺字段） ----------

export interface LegacyUser {
  id?: string;
  username?: string;
  email?: string;
  passwordHash?: string | null;
  role?: string;
  emailVerified?: boolean;
  oauthProvider?: string | null;
  oauthSubject?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface LegacyEntry {
  id?: string;
  position?: number;
  player?: string;
  rank?: string;
  points?: number;
  testServer?: string | null;
  categories?: Record<string, string | null>;
  createdAt?: string;
  updatedAt?: string;
}

export interface LegacySettings {
  registrationEnabled?: boolean;
  oauthEnabled?: boolean;
  oauthMicrosoft?: { clientId?: string; tenant?: string };
}

export interface LegacyData {
  users: LegacyUser[];
  entries: LegacyEntry[];
  settings: LegacySettings;
}

export interface ImportReport {
  users: number;
  /** 与目标库中已存在的账号合并（同名或同邮箱但 id 不同）的条数。 */
  usersMerged: number;
  categories: number;
  entries: number;
  tiers: number;
  settings: number;
  /** 定级引用了不存在的项目（理论上不会发生，因为项目取自并集）。 */
  skippedTiers: { player: string; category: string }[];
  /** 跳过的无效记录，例如没有用户名。 */
  skippedRecords: string[];
  rankingSample: string[];
  /**
   * 导入后目标库里的全部 SuperAdmin 用户名（字母序）。
   *
   * 必须让人看见：normalizeRole 忠实沿用了旧站「role === 'admin' 即 SuperAdmin」
   * 的规则，于是旧数据里有几个这样的账号，导入后就有几个 SuperAdmin。而新站的
   * userService 拒绝对任何 SuperAdmin 执行降级/删除，多出来的那些在后台里
   * 是动不了的——这件事必须在切换清单第 3 步就被看到，而不是上线后才发现。
   */
  superAdmins: string[];
}

export interface Conflict {
  kind: 'username' | 'email';
  value: string;
  ids: string[];
}

const lower = (value: string): string => value.trim().toLowerCase();
const nowIso = (): string => new Date().toISOString();

/** 沿用旧站 migrateUserShape 的归一规则，避免迁移顺手改变既有语义。 */
export function normalizeRole(
  raw: string | undefined,
  username: string,
  superAdminName: string
): Role {
  if (raw === 'admin' || username === superAdminName) return 'SuperAdmin';
  return ROLES.includes(raw as Role) ? (raw as Role) : 'User';
}

/**
 * 检出只差大小写的重复用户名/邮箱。
 * 新库的小写影子列是唯一的，这类数据必须先由人决定保留哪条，
 * 静默丢一条账户是不可接受的。
 */
export function findConflicts(users: LegacyUser[]): Conflict[] {
  const conflicts: Conflict[] = [];
  for (const kind of ['username', 'email'] as const) {
    const seen = new Map<string, string[]>();
    for (const user of users) {
      const raw = kind === 'username' ? user.username : user.email;
      if (!raw) continue;
      const key = lower(raw);
      const bucket = seen.get(key) ?? [];
      bucket.push(user.id ?? '(无 id)');
      seen.set(key, bucket);
    }
    for (const [value, ids] of seen) {
      if (ids.length > 1) conflicts.push({ kind, value, ids });
    }
  }
  return conflicts;
}

/**
 * 把旧数据导进目标库。
 *
 * `driver` 必须显式传：upsert 的语法三方言不通用（见 app/db/upsert.ts），而这里
 * 拿到的是一个 `Transaction`，没法像 repository 那样从 DbManager 现取当前方言。
 */
export async function importLegacyData(
  trx: Transaction<Database>,
  data: LegacyData,
  superAdminName: string,
  driver: DbDriver
): Promise<ImportReport> {
  const report: ImportReport = {
    users: 0,
    usersMerged: 0,
    categories: 0,
    entries: 0,
    tiers: 0,
    settings: 0,
    skippedTiers: [],
    skippedRecords: [],
    rankingSample: [],
    superAdmins: []
  };

  // --- 用户 ---
  for (const user of data.users) {
    const username = (user.username ?? '').trim();
    if (!username) {
      report.skippedRecords.push(`用户 ${user.id ?? '(无 id)'}：缺少用户名`);
      continue;
    }
    const role = normalizeRole(user.role, username, superAdminName);
    const email = (user.email ?? '').trim() || `${username}@local`;
    const timestamp = user.createdAt ?? nowIso();

    const row = {
      id: user.id ?? `user-${lower(username)}`,
      username,
      username_lower: lower(username),
      email,
      email_lower: lower(email),
      password_hash: user.passwordHash ?? null,
      role,
      email_verified:
        typeof user.emailVerified === 'boolean'
          ? Number(user.emailVerified)
          : Number(role === 'SuperAdmin'),
      oauth_provider: user.oauthProvider ?? null,
      oauth_subject: user.oauthSubject ?? null,
      created_at: timestamp,
      updated_at: user.updatedAt ?? timestamp
    };

    /*
     * 按 id 之外，还要按用户名/邮箱找已存在的账号。
     *
     * 真实场景：新站启动时 ensureSuperAdmin 会 seed 一个 admin（id 由
     * randomUUID 生成），随后导入旧数据里同名的 admin-1 —— 两者 id 不同但
     * email 相同，只按 id upsert 会撞上 email_lower 的唯一约束。
     * 这里把它们视为同一个账号：保留目标库已有的 id，更新其余字段。
     */
    const existing = await trx
      .selectFrom('users')
      .select('id')
      .where((eb) =>
        eb.or([
          eb('id', '=', row.id),
          eb('username_lower', '=', row.username_lower),
          eb('email_lower', '=', row.email_lower)
        ])
      )
      .executeTakeFirst();

    if (existing) {
      const { id: _id, ...fields } = row;
      await trx.updateTable('users').set(fields).where('id', '=', existing.id).execute();
      if (existing.id !== row.id) report.usersMerged += 1;
    } else {
      await trx.insertInto('users').values(row).execute();
    }
    report.users += 1;
  }

  /*
   * --- 细分项目：旧结构里是所有条目 categories 键的并集 ---
   *
   * 按 `name_lower` 去重而不是按原始键。旧站的项目名来自 Excel 表头
   * （`String(header).trim()`，不校验大小写），同一个项目在不同条目里写成
   * `Crystal` 和 `crystal` 是完全可能的；而目标库里 `name_lower` 是唯一的，
   * 两个键只会对应同一行。按原始键建映射的话，后面写 entry_tiers 时这两个键
   * 会给出同一个 category_id，撞上 (entry_id, category_id) 主键，整个导入事务
   * 回滚——恰好是这段代码最该容忍的那类历史数据。
   */
  const categoryNameByLower = new Map<string, string>();
  for (const entry of data.entries) {
    for (const name of Object.keys(entry.categories ?? {})) {
      // 首次出现的写法胜出，只是为了让结果稳定
      if (!categoryNameByLower.has(lower(name))) categoryNameByLower.set(lower(name), name);
    }
  }

  const categoryIdByLower = new Map<string, string>();
  for (const key of [...categoryNameByLower.keys()].sort()) {
    const name = categoryNameByLower.get(key)!;
    const existing = await trx
      .selectFrom('categories')
      .select(['id'])
      .where('name_lower', '=', key)
      .executeTakeFirst();

    if (existing) {
      categoryIdByLower.set(key, existing.id);
      continue;
    }
    /*
     * id 用随机值而不是从名字派生。派生写法（`cat-` + 名字里非字母数字替换成 `-`）
     * 会把 `Crystal PvP` 与 `Crystal-PvP` 这两个不同的 name_lower 折叠成同一个
     * id，插入时主键冲突、整批回滚。幂等性不靠 id 稳定，靠的是上面那次
     * name_lower 查找。
     */
    const id = `cat-${randomUUID()}`;
    await trx
      .insertInto('categories')
      .values({ id, name, name_lower: key, created_at: nowIso() })
      .execute();
    categoryIdByLower.set(key, id);
    report.categories += 1;
  }

  // --- 条目与定级 ---
  for (const entry of data.entries) {
    const player = (entry.player ?? '').trim();
    if (!player) {
      report.skippedRecords.push(`条目 ${entry.id ?? '(无 id)'}：缺少玩家名`);
      continue;
    }
    const timestamp = entry.createdAt ?? nowIso();
    const testServer = (entry.testServer ?? '').trim();
    const row = {
      id: entry.id ?? `entry-${lower(player)}`,
      player,
      player_lower: lower(player),
      rank_label: (entry.rank ?? 'Unranked').trim() || 'Unranked',
      points: Number(entry.points ?? 0),
      // 旧数据里空字符串与 null 混用，统一归一为 null
      test_server: testServer === '' ? null : testServer,
      created_at: timestamp,
      updated_at: entry.updatedAt ?? timestamp
    };

    await upsertRow(trx.insertInto('entries').values(row), driver, ['id'], row).execute();
    report.entries += 1;

    // 重跑时先清掉旧定级，保证幂等
    await trx.deleteFrom('entry_tiers').where('entry_id', '=', row.id).execute();

    // 同一条目里只差大小写的两个键指向同一行，第二个必须丢掉而不是撞主键
    const writtenCategories = new Set<string>();
    for (const [name, tier] of Object.entries(entry.categories ?? {})) {
      // 旧结构用 null 占位表示未定级；新结构直接不建行
      if (tier === null || tier === undefined || String(tier).trim() === '') continue;
      const categoryId = categoryIdByLower.get(lower(name));
      if (!categoryId) {
        report.skippedTiers.push({ player, category: name });
        continue;
      }
      if (writtenCategories.has(categoryId)) {
        report.skippedRecords.push(
          `条目 ${player}：细分项目 ${name} 与已写入的同名项目重复，已跳过`
        );
        continue;
      }
      writtenCategories.add(categoryId);
      await trx
        .insertInto('entry_tiers')
        .values({ entry_id: row.id, category_id: categoryId, tier: String(tier).trim() })
        .execute();
      report.tiers += 1;
    }
  }

  // --- 设置：拆成 key/value 行；旧的 migrations 标志位丢弃 ---
  const settingsToWrite: Record<string, unknown> = {
    registrationEnabled: data.settings.registrationEnabled ?? false,
    oauthEnabled: data.settings.oauthEnabled ?? false,
    oauthMicrosoft: {
      clientId: data.settings.oauthMicrosoft?.clientId ?? '',
      tenant: data.settings.oauthMicrosoft?.tenant ?? 'common'
    }
  };
  for (const [key, value] of Object.entries(settingsToWrite)) {
    const serialized = JSON.stringify(value);
    await upsertRow(
      trx.insertInto('settings').values({ setting_key: key, setting_value: serialized }),
      driver,
      ['setting_key'],
      { setting_value: serialized }
    ).execute();
    report.settings += 1;
  }

  // --- 排名一致性抽样 ---
  const importedEntries = await trx.selectFrom('entries').select(['player', 'points']).execute();
  report.rankingSample = formatRanking(importedEntries);

  // --- 导入后的 SuperAdmin 清单（供人工核对，见 ImportReport 上的说明）---
  const supers = await trx
    .selectFrom('users')
    .select('username')
    .where('role', '=', 'SuperAdmin')
    .execute();
  report.superAdmins = supers.map((row) => row.username).sort((a, b) => a.localeCompare(b));

  return report;
}

/** 供导入后与旧数据对比的统一格式。 */
export function formatRanking(entries: { player: string; points: number }[], limit = 10): string[] {
  return rankEntries(entries)
    .slice(0, limit)
    .map((item) => `${String(item.position)}. ${item.player} (${String(item.points)})`);
}
