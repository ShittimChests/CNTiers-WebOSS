import type { Insertable, Selectable, Updateable } from 'kysely';

/**
 * 数据库表结构 —— 一份定义，SQLite / PostgreSQL / MySQL 三方言通用。
 *
 * 为了让同一份 schema 在三种方言下行为一致，这里刻意做了三项收敛：
 *   1. 布尔用 0/1 的 integer——SQLite 无原生布尔，MySQL 的 tinyint(1) 读回类型
 *      又随驱动而异；统一成数字后由 repository 转换。
 *   2. 时间戳一律 ISO-8601 字符串。既与旧 JSON 数据同构（迁移零转换），
 *      又能直接按字典序比较大小，规避三方言的日期函数差异与 pg 的 bigint→string。
 *   3. 需要建索引/唯一约束的列用 varchar(n) 而非 text——MySQL 的 TEXT 列
 *      不指定前缀长度无法建唯一索引。
 */

export interface UsersTable {
  id: string;
  username: string;
  /** 小写影子列。三方言的大小写不敏感比较语义不同，用影子列绕开 COLLATE。 */
  username_lower: string;
  email: string;
  email_lower: string;
  /** OAuth-only 账户为 null，此时禁止解绑（否则用户会被锁在门外）。 */
  password_hash: string | null;
  role: string;
  email_verified: number;
  oauth_provider: string | null;
  oauth_subject: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * 邮箱验证码与密码重置码。取代旧 users 表上散落的 8 个字段
 * （verifyToken/verifyExpires/verifyAttempts/passwordResetToken/... /mailCooldown）。
 * 每个用户每种用途至多一条，签发即覆盖。
 */
export interface VerificationCodesTable {
  user_id: string;
  /** 'verify_email' | 'reset_password'，见 config/constants.ts。 */
  purpose: string;
  /** HMAC-SHA256(派生密钥, 明文码) 的十六进制，明文永不落库。 */
  code_hash: string;
  expires_at: string;
  attempts: number;
  /** 用于 30 秒发信冷却判定。 */
  last_sent_at: string;
}

export interface EntriesTable {
  id: string;
  player: string;
  player_lower: string;
  /** 段位显示文本。列名避开 `rank`——它在 MySQL 8 与 PostgreSQL 中都是保留字。 */
  rank_label: string;
  points: number;
  test_server: string | null;
  created_at: string;
  updated_at: string;
}

export interface CategoriesTable {
  id: string;
  name: string;
  name_lower: string;
  created_at: string;
}

/** 只存已定级的格子；未定级 = 无行（对应旧结构里的 null 值）。 */
export interface EntryTiersTable {
  entry_id: string;
  category_id: string;
  /** 原始字符串如 'HT1'。不加约束——历史数据含无法解析的值。 */
  tier: string;
}

/** 列名避开 `key` / `value`——两者都是 MySQL 保留字。 */
export interface SettingsTable {
  setting_key: string;
  /** JSON 文本。标量也包成 JSON，读写两端才对称。 */
  setting_value: string;
}

export interface SessionsTable {
  sid: string;
  /** 登录后回填，删除用户时据此清理其会话。 */
  user_id: string | null;
  data: string;
  expires_at: string;
}

export interface Database {
  users: UsersTable;
  verification_codes: VerificationCodesTable;
  entries: EntriesTable;
  categories: CategoriesTable;
  entry_tiers: EntryTiersTable;
  settings: SettingsTable;
  sessions: SessionsTable;
}

export type UserRow = Selectable<UsersTable>;
export type NewUserRow = Insertable<UsersTable>;
export type UserRowUpdate = Updateable<UsersTable>;

export type VerificationCodeRow = Selectable<VerificationCodesTable>;
export type NewVerificationCodeRow = Insertable<VerificationCodesTable>;

export type EntryRow = Selectable<EntriesTable>;
export type NewEntryRow = Insertable<EntriesTable>;
export type EntryRowUpdate = Updateable<EntriesTable>;

export type CategoryRow = Selectable<CategoriesTable>;
export type EntryTierRow = Selectable<EntryTiersTable>;
export type SettingsRow = Selectable<SettingsTable>;
export type SessionRow = Selectable<SessionsTable>;
