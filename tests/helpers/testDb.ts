/**
 * 测试数据库辅助。
 *
 * 默认用 SQLite 内存库；设置 TEST_DIALECT=postgres|mysql 时连到 CI 的服务容器，
 * 同一套 repository 测试便可在三种方言上重跑——这正是验证「方言透明」的手段，
 * 也是热切库功能能成立的前提。
 */
import { createKysely, type DbConnectionConfig } from '../../app/db/dialects.js';
import { DbManager } from '../../app/db/manager.js';
import { runMigrations } from '../../app/db/migrator.js';

/** 外键依赖顺序：先删子表。清空数据但保留结构，比重跑迁移快得多。 */
const TABLES_IN_DELETE_ORDER = [
  'entry_tiers',
  'verification_codes',
  'sessions',
  'entries',
  'categories',
  'users',
  'settings'
] as const;

function parseUrl(raw: string, fallbackPort: number) {
  const url = new URL(raw);
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : fallbackPort,
    database: url.pathname.replace(/^\//, ''),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    ssl: false
  };
}

export function testDbConfig(): DbConnectionConfig {
  const dialect = process.env['TEST_DIALECT'] ?? 'sqlite';

  if (dialect === 'postgres') {
    const url = process.env['TEST_PG_URL'];
    if (!url) throw new Error('TEST_DIALECT=postgres 需要同时提供 TEST_PG_URL');
    return { driver: 'postgres', ...parseUrl(url, 5432) };
  }

  if (dialect === 'mysql') {
    const url = process.env['TEST_MYSQL_URL'];
    if (!url) throw new Error('TEST_DIALECT=mysql 需要同时提供 TEST_MYSQL_URL');
    return { driver: 'mysql', ...parseUrl(url, 3306) };
  }

  return { driver: 'sqlite', file: ':memory:' };
}

export interface TestDb {
  manager: DbManager;
  /** 清空全部业务数据，供 beforeEach 使用。 */
  reset: () => Promise<void>;
  close: () => Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const dbConfig = testDbConfig();
  const manager = new DbManager();
  await manager.switchTo(await createKysely(dbConfig), dbConfig);

  // 服务型数据库在 CI 中会被多个测试文件复用，先把上一轮的结构清掉
  if (dbConfig.driver !== 'sqlite') {
    const db = manager.db();
    for (const table of TABLES_IN_DELETE_ORDER) {
      await db.schema.dropTable(table).ifExists().execute();
    }
    await db.schema.dropTable('kysely_migration').ifExists().execute();
    await db.schema.dropTable('kysely_migration_lock').ifExists().execute();
  }

  await runMigrations(manager.db());

  return {
    manager,
    reset: async () => {
      const db = manager.db();
      for (const table of TABLES_IN_DELETE_ORDER) {
        await db.deleteFrom(table).execute();
      }
    },
    close: () => manager.close()
  };
}
