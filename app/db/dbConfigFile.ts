import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { config } from '../config/env.js';
import { DB_DRIVERS, DEFAULT_SQLITE_CONFIG, type DbConnectionConfig } from './dialects.js';

/**
 * 数据库连接配置的持久化。
 *
 * 存文件而不是存数据库——连接信息本身就是「怎么连数据库」，放进数据库
 * 是鸡生蛋。文件不存在即视为默认的 SQLite，因此全新部署零配置即可跑。
 *
 * 权限 0600：里面可能有 PostgreSQL / MySQL 的密码。
 */

const CONFIG_PATH = resolve(config.dataDir, 'db-config.json');

/**
 * 布尔字段一律「缺失也算合法」。
 *
 * 这一条不是风格问题：isValidConfig 判否的后果是**静默退回默认 SQLite**
 * （见 loadDbConfig），运维看到的是一个空库，很像数据全丢了。所以对可选字段
 * 只拒绝类型错误的值，不拒绝缺失。
 */
function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean';
}

function isValidConfig(value: unknown): value is DbConnectionConfig {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  const driver = record['driver'];
  if (typeof driver !== 'string' || !DB_DRIVERS.includes(driver as never)) return false;

  if (driver === 'sqlite') return typeof record['file'] === 'string';

  return (
    typeof record['host'] === 'string' &&
    typeof record['port'] === 'number' &&
    typeof record['database'] === 'string' &&
    typeof record['user'] === 'string' &&
    typeof record['password'] === 'string' &&
    isOptionalBoolean(record['ssl']) &&
    isOptionalBoolean(record['sslInsecure'])
  );
}

/** 读取当前配置。文件缺失、损坏或被 FORCE_SQLITE 覆盖时退回默认 SQLite。 */
export async function loadDbConfig(): Promise<DbConnectionConfig> {
  if (config.forceSqlite) {
    console.warn('⚠️  FORCE_SQLITE 已设置，忽略 db-config.json，使用默认 SQLite。');
    return DEFAULT_SQLITE_CONFIG;
  }

  try {
    const parsed: unknown = JSON.parse(await readFile(CONFIG_PATH, 'utf-8'));
    if (!isValidConfig(parsed)) {
      console.error(
        `✖ ${CONFIG_PATH} 内容不是合法的连接配置，已退回默认 SQLite。` +
          '若要恢复，请修正或删除该文件。'
      );
      return DEFAULT_SQLITE_CONFIG;
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return DEFAULT_SQLITE_CONFIG;
    }
    throw error;
  }
}

/** 原子写入：先写临时文件再 rename，避免进程在写一半时崩溃留下残缺配置。 */
export async function saveDbConfig(next: DbConnectionConfig): Promise<void> {
  await mkdir(dirname(CONFIG_PATH), { recursive: true });
  const temp = `${CONFIG_PATH}.tmp`;
  await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
  await rename(temp, CONFIG_PATH);
}

export { CONFIG_PATH as DB_CONFIG_PATH };
