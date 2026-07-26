import { inspect } from 'node:util';
import type { Kysely } from 'kysely';
// Kysely 0.29 起迁移 API 移到了独立子路径
import { Migrator, type Migration, type MigrationProvider } from 'kysely/migration';
import * as init001 from './migrations/001_init.js';
import type { Database } from './types.js';

/**
 * 迁移用静态注册表而非 FileMigrationProvider。
 *
 * 文件扫描在这个项目里是个陷阱：开发态跑的是 app/db/migrations/*.ts，
 * 生产跑的是 dist/server/db/migrations/*.js，路径与扩展名都不同。
 * 静态注册让编译产物自包含，也让「漏打包迁移文件」变成编译期错误。
 *
 * 新增迁移：在此追加一行，键名必须单调递增（Kysely 按键名排序执行）。
 */
const MIGRATIONS: Record<string, Migration> = {
  '001_init': init001
};

const provider: MigrationProvider = {
  getMigrations: () => Promise.resolve(MIGRATIONS)
};

export const MIGRATION_KEYS = Object.keys(MIGRATIONS).sort();
/** 全部迁移执行完毕后应处于的版本，用于切库时比对目标库结构。 */
export const LATEST_MIGRATION = MIGRATION_KEYS[MIGRATION_KEYS.length - 1]!;

export function createMigrator(db: Kysely<Database>): Migrator {
  return new Migrator({ db, provider });
}

export interface MigrationOutcome {
  applied: string[];
}

/** 把目标库结构推进到最新。已是最新则为空操作。 */
export async function runMigrations(db: Kysely<Database>): Promise<MigrationOutcome> {
  const migrator = createMigrator(db);
  const { error, results } = await migrator.migrateToLatest();

  if (error) {
    throw error instanceof Error ? error : new Error(`迁移执行失败：${inspect(error)}`);
  }

  const applied = (results ?? [])
    .filter((result) => result.status === 'Success')
    .map((result) => result.migrationName);

  return { applied };
}

/** 目标库当前已执行到哪一版；从未迁移过则返回 null。 */
export async function currentMigrationVersion(db: Kysely<Database>): Promise<string | null> {
  const migrator = createMigrator(db);
  const executed = (await migrator.getMigrations()).filter((m) => m.executedAt !== undefined);
  if (executed.length === 0) return null;
  return executed[executed.length - 1]!.name;
}
