/**
 * 旧 JSON 数据 → 数据库的导入逻辑。
 *
 * 与 CLI（scripts/migrate-json.ts）分离，好处是这段决定生产数据命运的代码
 * 可以被测试直接调用，而不必去驱动一个进程。M8 删除旧站时本文件一并删除。
 */
import type { Transaction } from 'kysely';
import { ROLES, type Role } from '../../app/config/constants.js';
import type { Database } from '../../app/db/types.js';
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

export async function importLegacyData(
  trx: Transaction<Database>,
  data: LegacyData,
  superAdminName: string
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
    rankingSample: []
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

  // --- 细分项目：旧结构里是所有条目 categories 键的并集 ---
  const categoryNames = [
    ...new Set(data.entries.flatMap((entry) => Object.keys(entry.categories ?? {})))
  ].sort();

  const categoryIdByName = new Map<string, string>();
  for (const name of categoryNames) {
    const existing = await trx
      .selectFrom('categories')
      .select(['id'])
      .where('name_lower', '=', lower(name))
      .executeTakeFirst();

    if (existing) {
      categoryIdByName.set(name, existing.id);
      continue;
    }
    const id = `cat-${lower(name).replace(/[^a-z0-9]+/g, '-')}`;
    await trx
      .insertInto('categories')
      .values({ id, name, name_lower: lower(name), created_at: nowIso() })
      .execute();
    categoryIdByName.set(name, id);
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

    await trx
      .insertInto('entries')
      .values(row)
      .onConflict((oc) => oc.column('id').doUpdateSet(row))
      .execute();
    report.entries += 1;

    // 重跑时先清掉旧定级，保证幂等
    await trx.deleteFrom('entry_tiers').where('entry_id', '=', row.id).execute();

    for (const [name, tier] of Object.entries(entry.categories ?? {})) {
      // 旧结构用 null 占位表示未定级；新结构直接不建行
      if (tier === null || tier === undefined || String(tier).trim() === '') continue;
      const categoryId = categoryIdByName.get(name);
      if (!categoryId) {
        report.skippedTiers.push({ player, category: name });
        continue;
      }
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
    await trx
      .insertInto('settings')
      .values({ setting_key: key, setting_value: serialized })
      .onConflict((oc) => oc.column('setting_key').doUpdateSet({ setting_value: serialized }))
      .execute();
    report.settings += 1;
  }

  // --- 排名一致性抽样 ---
  const importedEntries = await trx.selectFrom('entries').select(['player', 'points']).execute();
  report.rankingSample = formatRanking(importedEntries);

  return report;
}

/** 供导入后与旧数据对比的统一格式。 */
export function formatRanking(entries: { player: string; points: number }[], limit = 10): string[] {
  return rankEntries(entries)
    .slice(0, limit)
    .map((item) => `${String(item.position)}. ${item.player} (${String(item.points)})`);
}
