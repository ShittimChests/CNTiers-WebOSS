import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app/app.js';
import { createKysely } from '../../app/db/dialects.js';
import { dbManager } from '../../app/db/manager.js';
import { runMigrations } from '../../app/db/migrator.js';
import { settingsService } from '../../app/services/settingsService.js';
import {
  importLegacyData,
  type LegacyEntry,
  type LegacySettings,
  type LegacyUser
} from '../../scripts/lib/legacyImport.js';

/**
 * 公开 API v1 的契约测试。
 *
 * 基线（tests/golden/api-v1.json）是用同一份 fixture 在**旧站**上录制的
 * 真实响应。这里把 fixture 灌进新实现，逐字段比对状态码、关键响应头与响应体。
 *
 * 外部机器人在消费这些端点，所以：**测试失败意味着契约被破坏，
 * 应当改实现而不是改基线**。只有在故意变更 API 时才重新录制
 * （npm run golden:record）。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN_PATH = resolve(HERE, '../golden/api-v1.json');
const FIXTURE_DIR = resolve(HERE, '../fixtures/legacy');

interface GoldenRecord {
  request: { method: string; path: string };
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

// 顶层同步读取：it.each 在用例收集阶段就需要拿到名字
const GOLDEN = JSON.parse(readFileSync(GOLDEN_PATH, 'utf-8')) as Record<string, GoldenRecord>;

let app: Express;

async function readFixture<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(resolve(FIXTURE_DIR, name), 'utf-8')) as T;
}

beforeAll(async () => {
  // createApp 走全局 dbManager，因此把它指向内存库。
  // Vitest 的测试文件彼此进程隔离，不会互相干扰。
  const dbConfig = { driver: 'sqlite' as const, file: ':memory:' };
  await dbManager.switchTo(await createKysely(dbConfig), dbConfig);
  await runMigrations(dbManager.db());

  const data = {
    users: await readFixture<LegacyUser[]>('users.json'),
    entries: await readFixture<LegacyEntry[]>('leaderboard.json'),
    settings: await readFixture<LegacySettings>('settings.json')
  };
  await dbManager
    .db()
    .transaction()
    .execute(async (trx) => {
      await importLegacyData(trx, data, 'admin', 'sqlite');
    });

  settingsService.invalidate();
  app = createApp();
});

afterAll(async () => {
  await dbManager.close();
});

describe('API v1 契约（对照旧站录制的基线）', () => {
  it('基线覆盖全部请求变体', () => {
    expect(Object.keys(GOLDEN).length).toBe(22);
  });

  it.each(Object.keys(GOLDEN))('%s', async (name) => {
    const expected = GOLDEN[name]!;
    const agent = request(app);
    const response =
      expected.request.method === 'OPTIONS'
        ? await agent.options(expected.request.path)
        : await agent.get(expected.request.path);

    expect(response.status, `${name} 的状态码`).toBe(expected.status);

    for (const [header, value] of Object.entries(expected.headers)) {
      expect(response.headers[header], `${name} 的 ${header} 响应头`).toBe(value);
    }

    if (expected.body === null) {
      expect(response.text, `${name} 应无响应体`).toBe('');
    } else {
      expect(response.body, `${name} 的响应体`).toEqual(expected.body);
    }
  });
});
