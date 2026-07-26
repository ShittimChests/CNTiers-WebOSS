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

const FIXTURE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures/legacy');

let app: Express;

async function readFixture<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(resolve(FIXTURE_DIR, name), 'utf-8')) as T;
}

/** 从渲染结果里抽出榜单行的玩家名，顺序即渲染顺序。 */
function playersOf(html: string): string[] {
  return [...html.matchAll(/board__player">\s*([^<]*?)\s*(?:<|$)/g)]
    .map((match) => match[1] ?? '')
    .filter((name) => name.length > 0);
}

beforeAll(async () => {
  const dbConfig = { driver: 'sqlite' as const, file: ':memory:' };
  await dbManager.switchTo(await createKysely(dbConfig), dbConfig);
  await runMigrations(dbManager.db());

  await dbManager
    .db()
    .transaction()
    .execute(async (trx) => {
      await importLegacyData(
        trx,
        {
          users: await readFixture<LegacyUser[]>('users.json'),
          entries: await readFixture<LegacyEntry[]>('leaderboard.json'),
          settings: await readFixture<LegacySettings>('settings.json')
        },
        'admin'
      );
    });

  settingsService.invalidate();
  app = createApp();
});

afterAll(async () => {
  await dbManager.close();
});

describe('榜单首页', () => {
  it('渲染全部条目，默认按名次', async () => {
    const response = await request(app).get('/');
    expect(response.status).toBe(200);
    expect(playersOf(response.text)).toEqual(['Carol', 'Alice', 'Bob', 'Dave']);
  });

  it('同分条目共享名次，前两名之后不再有 top3 描边', async () => {
    const html = (await request(app).get('/')).text;
    // Alice 与 Bob 同为第 2 名
    expect([...html.matchAll(/board__row--top(\d)/g)].map((m) => m[1])).toEqual(['1', '2', '2']);
  });

  it('段位映射到材质档，认不出的退回石质', async () => {
    const html = (await request(app).get('/')).text;
    expect([...html.matchAll(/badge badge--(\w+)/g)].map((m) => m[1])).toEqual([
      'netherite',
      'emerald',
      'emerald',
      // fixture 里 Dave 的段位是 Unranked，不在七档之内
      'stone'
    ]);
  });

  it('按玩家名与积分排序，支持升降序', async () => {
    expect(playersOf((await request(app).get('/?sort=player&dir=asc')).text)).toEqual([
      'Alice',
      'Bob',
      'Carol',
      'Dave'
    ]);
    expect(playersOf((await request(app).get('/?sort=player&dir=desc')).text)).toEqual([
      'Dave',
      'Carol',
      'Bob',
      'Alice'
    ]);
    expect(playersOf((await request(app).get('/?sort=points&dir=asc')).text)[0]).toBe('Dave');
  });

  it('非法排序参数退回默认，而不是报错', async () => {
    const response = await request(app).get('/?sort=bogus&dir=sideways');
    expect(response.status).toBe(200);
    expect(playersOf(response.text)).toEqual(['Carol', 'Alice', 'Bob', 'Dave']);
  });

  it('搜索覆盖玩家名、段位与定级', async () => {
    expect(playersOf((await request(app).get('/?q=alice')).text)).toEqual(['Alice']);
    expect(playersOf((await request(app).get('/?q=HT1')).text)).toEqual(['Carol']);
    expect(playersOf((await request(app).get('/?q=grandmaster')).text)).toEqual(['Carol']);
  });

  it('搜索无结果时给出空态与可操作提示', async () => {
    const response = await request(app).get('/?q=没有这个人');
    expect(playersOf(response.text)).toEqual([]);
    expect(response.text).toContain('class="empty"');
    expect(response.text).toContain('换个关键词试试');
  });

  it('搜索时保留排序参数，切换排序时保留搜索词', async () => {
    const html = (await request(app).get('/?q=alice&sort=points&dir=desc')).text;
    expect(html).toContain('<input type="hidden" name="sort" value="points"');
    expect(html).toContain('<input type="hidden" name="dir" value="desc"');
    // 排序链接里带上 q
    expect(html).toContain('q=alice');
  });

  it('统计数字反映全榜规模，不受搜索影响', async () => {
    const html = (await request(app).get('/?q=alice')).text;
    const numbers = [...html.matchAll(/board-stats__num">(\d+)/g)].map((m) => m[1]);
    expect(numbers).toEqual(['4', '4']);
  });

  it('当前排序项标记 aria-current 并带屏幕阅读器说明', async () => {
    const html = (await request(app).get('/?sort=points&dir=desc')).text;
    expect(html).toContain('aria-current="true"');
    expect(html).toContain('当前按积分降序');
  });

  it('无内联样式与内联事件（CSP 已收紧）', async () => {
    const html = (await request(app).get('/')).text;
    expect(html).not.toMatch(/\sstyle="/);
    expect(html).not.toMatch(/\son[a-z]+="/);
  });

  it('只加载首页需要的按页脚本', async () => {
    const html = (await request(app).get('/')).text;
    expect(html).toMatch(/board\.[A-Za-z0-9_-]+\.js|client\/pages\/board\.ts/);
  });
});

describe('API 文档页', () => {
  it('渲染并用请求自身的 host 拼示例', async () => {
    const response = await request(app).get('/api/docs').set('Host', 'example.test');
    expect(response.status).toBe(200);
    expect(response.text).toContain('http://example.test/api/v1/gamemodes');
  });

  it('文档里的限流与缓存数值取自同一份常量', async () => {
    const html = (await request(app).get('/api/docs')).text;
    expect(html).toContain('60 次 / 分钟');
    expect(html).toContain('max-age=60');
  });

  it('列出四个端点与全部错误码', async () => {
    const html = (await request(app).get('/api/docs')).text;
    for (const path of [
      '/api/v1/gamemodes',
      '/api/v1/rankings',
      '/api/v1/rankings/{gamemode}',
      '/api/v1/players/{name}'
    ]) {
      expect(html).toContain(path);
    }
    for (const code of ['invalid_query', 'gamemode_not_found', 'rate_limited', 'internal_error']) {
      expect(html).toContain(code);
    }
  });
});

describe('错误出口', () => {
  it('未知页面渲染 HTML 错误页', async () => {
    const response = await request(app).get('/no-such-page');
    expect(response.status).toBe(404);
    expect(response.headers['content-type']).toMatch(/text\/html/);
    expect(response.text).toContain('页面不存在');
  });

  it('未知 API 路径返回 JSON 信封', async () => {
    const response = await request(app).get('/api/v1/no-such-endpoint');
    expect(response.status).toBe(404);
    expect(response.headers['content-type']).toMatch(/application\/json/);
    expect(response.body).toEqual({
      error: 'not_found',
      message: "route 'GET /api/v1/no-such-endpoint' does not exist"
    });
  });

  it('公开 API 不受 CSRF 中间件影响（挂载顺序）', async () => {
    const response = await request(app).get('/api/v1/gamemodes');
    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('gamemodes');
  });
});
