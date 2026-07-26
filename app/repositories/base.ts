import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { dbManager, type DbManager } from '../db/manager.js';
import type { Database } from '../db/types.js';

/**
 * 所有 repository 的基类。
 *
 * 关键约定：`db` 是 getter，每次访问都向 DbManager 重新索取当前实例，
 * 绝不在构造时捕获。热切库靠的就是这一点——切换后所有 repository
 * 自动指向新库，无需重建或通知。
 */
export abstract class BaseRepository {
  constructor(protected readonly manager: DbManager = dbManager) {}

  protected get db(): Kysely<Database> {
    return this.manager.db();
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

/** 0/1 ↔ boolean：三方言对布尔的表示不一致，统一在此转换。 */
export function toBool(value: number | boolean | null | undefined): boolean {
  return value === 1 || value === true;
}

export function fromBool(value: boolean): number {
  return value ? 1 : 0;
}

/** 大小写不敏感查找统一走影子列，避免依赖各方言的 COLLATE 语义。 */
export function lower(value: string): string {
  return value.trim().toLowerCase();
}
