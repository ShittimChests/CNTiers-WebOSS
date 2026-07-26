/**
 * 方言工厂的 TLS 行为。
 *
 * 单独成文件是因为它必须 mock 掉 pg / mysql2：这两条分支在测试里从不真的
 * 建连（CI 的 PG/MySQL 矩阵走的是 ssl:false），于是「开了 SSL 到底校不校验
 * 证书」这件事没有任何东西守着——而它正是一个安全默认值。
 */
import { describe, expect, it, vi } from 'vitest';

const { pgPools, mysqlPools } = vi.hoisted(() => ({
  pgPools: [] as Record<string, unknown>[],
  mysqlPools: [] as Record<string, unknown>[]
}));

vi.mock('pg', () => ({
  default: {
    Pool: class {
      constructor(config: Record<string, unknown>) {
        pgPools.push(config);
      }
    }
  }
}));

vi.mock('mysql2', () => ({
  createPool: (config: Record<string, unknown>) => {
    mysqlPools.push(config);
    return {};
  }
}));

const { createDialect, describeConnection } = await import('../../app/db/dialects.js');

const SERVER = {
  host: 'db.example.com',
  port: 5432,
  database: 'subtier',
  user: 'app',
  password: 'secret'
};

function lastPgPool(): Record<string, unknown> {
  const config = pgPools.at(-1);
  if (!config) throw new Error('没有创建过 pg 连接池');
  return config;
}

function lastMysqlPool(): Record<string, unknown> {
  const config = mysqlPools.at(-1);
  if (!config) throw new Error('没有创建过 mysql 连接池');
  return config;
}

describe('createDialect · TLS', () => {
  it('PostgreSQL 开 SSL 时默认校验证书', async () => {
    await createDialect({ driver: 'postgres', ...SERVER, ssl: true });
    expect(lastPgPool()['ssl']).toEqual({ rejectUnauthorized: true });
  });

  it('PostgreSQL 只有 sslInsecure 才跳过校验', async () => {
    await createDialect({ driver: 'postgres', ...SERVER, ssl: true, sslInsecure: true });
    expect(lastPgPool()['ssl']).toEqual({ rejectUnauthorized: false });
  });

  it('PostgreSQL 不开 SSL 时传 false', async () => {
    await createDialect({ driver: 'postgres', ...SERVER, ssl: false, sslInsecure: true });
    // 不开 TLS 时 sslInsecure 无意义，不该把它升级成一个「开了但不校验」的连接
    expect(lastPgPool()['ssl']).toBe(false);
  });

  it('MySQL 开 SSL 时默认校验证书', async () => {
    await createDialect({ driver: 'mysql', ...SERVER, port: 3306, ssl: true });
    expect(lastMysqlPool()['ssl']).toEqual({ rejectUnauthorized: true });
  });

  it('MySQL 的「不启用」是 undefined 而不是 false（驱动语义不同，别顺手统一）', async () => {
    await createDialect({ driver: 'mysql', ...SERVER, port: 3306, ssl: false });
    expect(lastMysqlPool()['ssl']).toBeUndefined();
  });
});

describe('describeConnection', () => {
  it('跳过证书校验会出现在摘要里', () => {
    // 否则勾上之后，面板、日志与探测结果里都再没有任何地方提醒它还开着
    expect(
      describeConnection({ driver: 'postgres', ...SERVER, ssl: true, sslInsecure: true })
    ).toBe('postgres://app@db.example.com:5432/subtier（TLS 未校验证书）');
  });

  it('正常连接的摘要不变，且永不含密码', () => {
    const summary = describeConnection({ driver: 'postgres', ...SERVER, ssl: true });
    expect(summary).toBe('postgres://app@db.example.com:5432/subtier');
    expect(summary).not.toContain('secret');
  });
});
