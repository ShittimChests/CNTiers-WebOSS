/**
 * upsert 的跨方言可移植性。
 *
 * 这条约束此前**只**由 CI 的 MySQL 矩阵守着，于是一个「onConflict 三方言通用」的
 * 错误假设一路合进了主线：Kysely 的 `MysqlQueryCompiler` 不会翻译 `onConflict()`，
 * 它照原样输出 PostgreSQL 语法，MySQL 报 ER_PARSE_ERROR。受影响的是会话写入、
 * 设置保存与验证码签发——也就是登录、后台保存、注册。
 *
 * 用 DummyDriver 只编译 SQL、不连库，所以这条守卫是本地的、毫秒级的。
 */
import {
  DummyDriver,
  Kysely,
  MysqlAdapter,
  MysqlIntrospector,
  MysqlQueryCompiler,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  type Dialect
} from 'kysely';
import { describe, expect, it } from 'vitest';
import type { DbDriver } from '../../app/db/dialects.js';
import type { Database } from '../../app/db/types.js';
import { upsertRow } from '../../app/db/upsert.js';

/** 只编译不连库的方言，用于断言生成的 SQL。 */
function compileOnlyDialect(driver: DbDriver): Dialect {
  if (driver === 'mysql') {
    return {
      createAdapter: () => new MysqlAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (db) => new MysqlIntrospector(db),
      createQueryCompiler: () => new MysqlQueryCompiler()
    };
  }
  if (driver === 'postgres') {
    return {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler()
    };
  }
  return {
    createAdapter: () => new SqliteAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new SqliteIntrospector(db),
    createQueryCompiler: () => new SqliteQueryCompiler()
  };
}

function sqlFor(driver: DbDriver): string {
  const db = new Kysely<Database>({ dialect: compileOnlyDialect(driver) });
  return upsertRow(
    db.insertInto('sessions').values({
      sid: 'sid-1',
      user_id: 'user-1',
      data: '{}',
      expires_at: '2026-01-01T00:00:00.000Z'
    }),
    driver,
    ['sid'],
    { user_id: 'user-1', data: '{}', expires_at: '2026-01-01T00:00:00.000Z' }
  ).compile().sql;
}

describe('upsertRow', () => {
  it('SQLite 用 ON CONFLICT (cols) DO UPDATE', () => {
    const sql = sqlFor('sqlite');
    expect(sql).toContain('on conflict ("sid") do update set');
  });

  it('PostgreSQL 用 ON CONFLICT (cols) DO UPDATE', () => {
    const sql = sqlFor('postgres');
    expect(sql).toContain('on conflict ("sid") do update set');
  });

  it('MySQL 用 ON DUPLICATE KEY UPDATE，且绝不出现 ON CONFLICT', () => {
    const sql = sqlFor('mysql');
    expect(sql).toContain('on duplicate key update');
    // 这就是那个 bug：MysqlQueryCompiler 会把 onConflict 原样吐出来，MySQL 语法错误
    expect(sql).not.toContain('on conflict');
  });

  it('三种方言都真的把冲突时要写的列带上了', () => {
    for (const driver of ['sqlite', 'postgres', 'mysql'] as const) {
      const sql = sqlFor(driver);
      expect(sql, driver).toMatch(/user_id/);
      expect(sql, driver).toMatch(/expires_at/);
    }
  });

  it('多列冲突键在 PG/SQLite 上都列出来', () => {
    for (const driver of ['sqlite', 'postgres'] as const) {
      const db = new Kysely<Database>({ dialect: compileOnlyDialect(driver) });
      const sql = upsertRow(
        db.insertInto('verification_codes').values({
          user_id: 'u',
          purpose: 'verify_email',
          code_hash: 'h',
          expires_at: 'x',
          attempts: 0,
          last_sent_at: 'y'
        }),
        driver,
        ['user_id', 'purpose'],
        { code_hash: 'h', attempts: 0 }
      ).compile().sql;
      expect(sql, driver).toMatch(/on conflict \("user_id", "purpose"\) do update set/);
    }
  });
});
