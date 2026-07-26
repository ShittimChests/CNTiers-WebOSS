import { isAbsolute, relative, resolve } from 'node:path';
import { Kysely, type Dialect } from 'kysely';
import { config } from '../config/env.js';
import { AppError } from '../errors/AppError.js';
import type { Database } from './types.js';

export const DB_DRIVERS = ['sqlite', 'postgres', 'mysql'] as const;
export type DbDriver = (typeof DB_DRIVERS)[number];

export interface SqliteConfig {
  driver: 'sqlite';
  /** 相对仓库 data/ 目录的文件名，或 data/ 内的绝对路径。 */
  file: string;
}

export interface ServerDbConfig {
  driver: 'postgres' | 'mysql';
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl: boolean;
}

export type DbConnectionConfig = SqliteConfig | ServerDbConfig;

export const DEFAULT_SQLITE_CONFIG: SqliteConfig = { driver: 'sqlite', file: 'subtier.db' };

/** 仅测试使用的内存库标记。 */
export const SQLITE_MEMORY = ':memory:';

/**
 * SQLite 文件必须落在 data/ 内。这个面板由 SuperAdmin 操作，但仍不该
 * 成为「往任意路径写文件」的原语——路径遍历会把它变成半个任意写。
 */
export function resolveSqlitePath(file: string): string {
  const absolute = isAbsolute(file) ? resolve(file) : resolve(config.dataDir, file);
  const rel = relative(config.dataDir, absolute);
  const escapes = rel.startsWith('..') || isAbsolute(rel);
  const hasValidSuffix = /\.(db|sqlite|sqlite3)$/i.test(absolute);
  if (escapes || !hasValidSuffix) {
    throw new AppError('db_invalid_path', {
      meta: { file, reason: escapes ? 'outside_data_dir' : 'bad_suffix' }
    });
  }
  return absolute;
}

/**
 * 按配置构造方言。三种驱动都是按需 import——用户可能 prune 掉用不到的驱动，
 * 顶层 import 会让整个进程起不来。
 */
export async function createDialect(dbConfig: DbConnectionConfig): Promise<Dialect> {
  if (dbConfig.driver === 'sqlite') {
    const { default: SQLite } = await import('better-sqlite3');
    const { SqliteDialect } = await import('kysely');
    // ':memory:' 只供测试使用，不是文件路径故不走路径校验；
    // 管理面板的输入校验不接受它（切过去等于把数据扔进内存）
    const target =
      dbConfig.file === SQLITE_MEMORY ? SQLITE_MEMORY : resolveSqlitePath(dbConfig.file);
    const database = new SQLite(target);
    // SQLite 默认不强制外键，级联删除会静默失效
    database.pragma('foreign_keys = ON');
    if (target !== SQLITE_MEMORY) {
      // WAL 让读写并发不互相阻塞，单机部署下收益明显（内存库不支持）
      database.pragma('journal_mode = WAL');
    }
    return new SqliteDialect({ database });
  }

  if (dbConfig.driver === 'postgres') {
    const { default: pg } = await import('pg');
    const { PostgresDialect } = await import('kysely');
    const pool = new pg.Pool({
      host: dbConfig.host,
      port: dbConfig.port,
      database: dbConfig.database,
      user: dbConfig.user,
      password: dbConfig.password,
      ssl: dbConfig.ssl ? { rejectUnauthorized: false } : false,
      max: 10,
      connectionTimeoutMillis: 10_000
    });
    return new PostgresDialect({ pool });
  }

  const { createPool } = await import('mysql2');
  const { MysqlDialect } = await import('kysely');
  const pool = createPool({
    host: dbConfig.host,
    port: dbConfig.port,
    database: dbConfig.database,
    user: dbConfig.user,
    password: dbConfig.password,
    ssl: dbConfig.ssl ? { rejectUnauthorized: false } : undefined,
    connectionLimit: 10,
    connectTimeout: 10_000,
    // 时间戳列是字符串，关掉驱动的日期解析以免类型漂移
    dateStrings: true
  });
  return new MysqlDialect({ pool });
}

export async function createKysely(dbConfig: DbConnectionConfig): Promise<Kysely<Database>> {
  const dialect = await createDialect(dbConfig);
  return new Kysely<Database>({ dialect });
}

/** 人类可读的连接摘要，用于日志与面板展示。绝不包含密码。 */
export function describeConnection(dbConfig: DbConnectionConfig): string {
  if (dbConfig.driver === 'sqlite') return `sqlite:${dbConfig.file}`;
  return `${dbConfig.driver}://${dbConfig.user}@${dbConfig.host}:${String(dbConfig.port)}/${dbConfig.database}`;
}
