/* eslint-disable @typescript-eslint/no-explicit-any -- 迁移在 schema 定型前运行，按 Kysely 惯例用 Kysely<any> */
import type { Kysely } from 'kysely';

/**
 * 初始结构。三方言通用，因此：
 *   - 索引列一律 varchar(n)（MySQL 的 TEXT 不给前缀长度无法建唯一索引）
 *   - 时间戳一律 varchar(32) 存 ISO-8601（可字典序比较，无驱动类型漂移）
 *   - 布尔一律 integer 0/1
 *   - 避开保留字：rank → rank_label，key/value → setting_key/setting_value
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('users')
    .addColumn('id', 'varchar(64)', (col) => col.primaryKey())
    .addColumn('username', 'varchar(32)', (col) => col.notNull())
    .addColumn('username_lower', 'varchar(32)', (col) => col.notNull().unique())
    .addColumn('email', 'varchar(254)', (col) => col.notNull())
    .addColumn('email_lower', 'varchar(254)', (col) => col.notNull().unique())
    .addColumn('password_hash', 'varchar(100)')
    .addColumn('role', 'varchar(16)', (col) => col.notNull().defaultTo('User'))
    .addColumn('email_verified', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('oauth_provider', 'varchar(32)')
    .addColumn('oauth_subject', 'varchar(128)')
    .addColumn('created_at', 'varchar(32)', (col) => col.notNull())
    .addColumn('updated_at', 'varchar(32)', (col) => col.notNull())
    // 三方言都允许唯一约束下存在多行 NULL，未绑定账户不会互相冲突
    .addUniqueConstraint('uq_users_oauth', ['oauth_provider', 'oauth_subject'])
    .execute();

  await db.schema
    .createTable('verification_codes')
    .addColumn('user_id', 'varchar(64)', (col) =>
      col.notNull().references('users.id').onDelete('cascade')
    )
    .addColumn('purpose', 'varchar(32)', (col) => col.notNull())
    .addColumn('code_hash', 'varchar(64)', (col) => col.notNull())
    .addColumn('expires_at', 'varchar(32)', (col) => col.notNull())
    .addColumn('attempts', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('last_sent_at', 'varchar(32)', (col) => col.notNull())
    .addPrimaryKeyConstraint('pk_verification_codes', ['user_id', 'purpose'])
    .execute();

  await db.schema
    .createTable('entries')
    .addColumn('id', 'varchar(64)', (col) => col.primaryKey())
    .addColumn('player', 'varchar(32)', (col) => col.notNull())
    .addColumn('player_lower', 'varchar(32)', (col) => col.notNull())
    .addColumn('rank_label', 'varchar(64)', (col) => col.notNull())
    .addColumn('points', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('test_server', 'varchar(64)')
    .addColumn('created_at', 'varchar(32)', (col) => col.notNull())
    .addColumn('updated_at', 'varchar(32)', (col) => col.notNull())
    .execute();

  // 榜单读取的主路径：按积分降序 + 同分按名字稳定排序
  await db.schema
    .createIndex('idx_entries_points')
    .on('entries')
    .columns(['points', 'player'])
    .execute();

  // /api/v1/players/:name 的大小写不敏感查找。不设唯一约束——旧数据无此保证
  await db.schema
    .createIndex('idx_entries_player_lower')
    .on('entries')
    .column('player_lower')
    .execute();

  await db.schema
    .createTable('categories')
    .addColumn('id', 'varchar(64)', (col) => col.primaryKey())
    .addColumn('name', 'varchar(48)', (col) => col.notNull().unique())
    .addColumn('name_lower', 'varchar(48)', (col) => col.notNull().unique())
    .addColumn('created_at', 'varchar(32)', (col) => col.notNull())
    .execute();

  await db.schema
    .createTable('entry_tiers')
    .addColumn('entry_id', 'varchar(64)', (col) =>
      col.notNull().references('entries.id').onDelete('cascade')
    )
    .addColumn('category_id', 'varchar(64)', (col) =>
      col.notNull().references('categories.id').onDelete('cascade')
    )
    .addColumn('tier', 'varchar(32)', (col) => col.notNull())
    .addPrimaryKeyConstraint('pk_entry_tiers', ['entry_id', 'category_id'])
    .execute();

  // 删除细分项目时按 category 扫描；/api/v1/rankings/:gamemode 也走这条
  await db.schema
    .createIndex('idx_entry_tiers_category')
    .on('entry_tiers')
    .column('category_id')
    .execute();

  await db.schema
    .createTable('settings')
    .addColumn('setting_key', 'varchar(64)', (col) => col.primaryKey())
    .addColumn('setting_value', 'text', (col) => col.notNull())
    .execute();

  await db.schema
    .createTable('sessions')
    .addColumn('sid', 'varchar(128)', (col) => col.primaryKey())
    .addColumn('user_id', 'varchar(64)')
    .addColumn('data', 'text', (col) => col.notNull())
    .addColumn('expires_at', 'varchar(32)', (col) => col.notNull())
    .execute();

  // 过期清扫
  await db.schema.createIndex('idx_sessions_expires').on('sessions').column('expires_at').execute();

  // 删除用户时一并踢掉其全部会话（旧实现缺失，属于安全缺陷）
  await db.schema.createIndex('idx_sessions_user').on('sessions').column('user_id').execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('sessions').ifExists().execute();
  await db.schema.dropTable('settings').ifExists().execute();
  await db.schema.dropTable('entry_tiers').ifExists().execute();
  await db.schema.dropTable('categories').ifExists().execute();
  await db.schema.dropTable('entries').ifExists().execute();
  await db.schema.dropTable('verification_codes').ifExists().execute();
  await db.schema.dropTable('users').ifExists().execute();
}
