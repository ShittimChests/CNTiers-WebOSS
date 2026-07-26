import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app/app.js';
import { config } from '../../app/config/env.js';
import { createKysely } from '../../app/db/dialects.js';
import { dbManager } from '../../app/db/manager.js';
import { runMigrations } from '../../app/db/migrator.js';
import { AppError } from '../../app/errors/AppError.js';
import { leaderboardService } from '../../app/services/leaderboardService.js';
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
        'admin',
        'sqlite'
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
  /*
   * 示例 URL 取 config.appBaseUrl，不跟随 Host。
   *
   * Host 是客户端可控的，让它决定页面上印出来的域名等于给了任何人一个
   * 「让本站展示他指定地址」的原语——curl 示例正是最容易被照抄执行的那种内容。
   */
  it('渲染示例时用配置的 baseUrl，不跟随 Host 头', async () => {
    const response = await request(app).get('/api/docs').set('Host', 'evil.test');
    expect(response.status).toBe(200);
    expect(response.text).toContain(`${config.appBaseUrl}/api/v1/gamemodes`);
    expect(response.text).not.toContain('evil.test');
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

  it.each([
    ['普通 Error', new Error('boom')],
    ['内部 AppError', new AppError('db_target_not_empty', { meta: { secret: 'x' } })]
  ])('API 的内部错误一律收敛成同一个英文 500 信封（%s）', async (_label, thrown) => {
    /*
     * 公开 API 对外承诺的错误码只有 5 个（见 ApiDocs 与 README）。让 AppError
     * 沿用自己的 code 会把 errors/codes.ts 那张 44 条内部码表接到匿名端点上，
     * 于是 `db_target_not_empty`、`cannot_modify_super` 这类内部管理词汇会外泄，
     * 还会产出 `404 + "unexpected server error"` 这种自相矛盾的信封。
     * 这条用例锁住「内部错误码不出网」。
     */
    const spy = vi.spyOn(leaderboardService, 'listRanked').mockRejectedValue(thrown);
    try {
      const response = await request(app).get('/api/v1/rankings');
      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        error: 'internal_error',
        message: 'unexpected server error'
      });
      // 信封里不该出现任何内部码名或中文
      expect(response.text).not.toContain('db_target_not_empty');
      // eslint-disable-next-line no-control-regex -- 断言的就是「不含非 ASCII」
      expect(/^[\x00-\x7F]*$/.test(response.text)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('公开 API 的 CORS 暴露清单', () => {
  /*
   * 自校验而不是把清单再抄一遍：断言「清单里写的名字，响应里真的存在」。
   *
   * 这条守的是一个很安静的失配——`standardHeaders: true` 在 express-rate-limit
   * 里会被归一成 draft-6，发的是 RateLimit-Policy / -Limit / -Remaining / -Reset；
   * 而裸的 `RateLimit` 是 draft-7 才有的。清单里写 `RateLimit` 的话，暴露的是一个
   * 永远不存在的头，真正带配额的 -Remaining 与 -Reset 反而仍然读不到，
   * 跨源调用方拿不到文档承诺的重试信息，且没有任何地方会报错。
   */
  it('清单里的每个 RateLimit 头都真的会发出来', async () => {
    const response = await request(app).get('/api/v1/gamemodes');
    expect(response.status).toBe(200);

    const exposed = (response.headers['access-control-expose-headers'] ?? '')
      .split(',')
      .map((name: string) => name.trim().toLowerCase())
      .filter((name: string) => name.length > 0);

    // Retry-After 只在 429 上出现，单独列出而不参与下面的存在性检查
    expect(exposed).toContain('retry-after');

    const rateLimitHeaders = exposed.filter((name: string) => name.startsWith('ratelimit'));
    expect(rateLimitHeaders.length).toBeGreaterThan(0);
    for (const name of rateLimitHeaders) {
      expect(response.headers[name], `${name} 在暴露清单里，但响应中并不存在`).toBeDefined();
    }
  });
});

describe('匿名请求不建立会话', () => {
  it('反复匿名 GET 既不下发 cookie 也不产生 sessions 行', async () => {
    /*
     * 这些都是被机器人反复命中的公开路径。若 CSRF 令牌被无条件铸造，
     * 每次命中都会改动会话，于 saveUninitialized:false 之下仍然落一行
     * sessions 并下发 Set-Cookie——写放大之外，带 Set-Cookie 的响应也
     * 不可能被任何共享缓存复用。
     */
    await dbManager.db().deleteFrom('sessions').execute();

    for (const path of ['/', '/', '/api/docs', '/no-such-page', '/api/v1/gamemodes']) {
      const response = await request(app).get(path);
      expect(response.headers['set-cookie'], `${path} 不该下发 cookie`).toBeUndefined();
    }

    expect(await dbManager.db().selectFrom('sessions').selectAll().execute()).toEqual([]);
  });
});
