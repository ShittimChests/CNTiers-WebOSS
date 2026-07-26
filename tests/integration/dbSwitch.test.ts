import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * 切库演练。
 *
 * 必须在 import 任何应用模块之前把 DATA_DIR 指到临时目录——config 是在模块
 * 加载时一次性读取并冻结的，晚了就会写到真实的 data/ 里去（连 db-config.json
 * 一起覆盖）。
 */
const DATA_DIR = mkdtempSync(resolve(tmpdir(), 'subtier-dbswitch-'));
process.env['DATA_DIR'] = DATA_DIR;
process.env['SESSION_SECRET'] = 'db-switch-test-secret';

const { createKysely } = await import('../../app/db/dialects.js');
const { dbManager } = await import('../../app/db/manager.js');
const { runMigrations } = await import('../../app/db/migrator.js');
const { DB_CONFIG_PATH } = await import('../../app/db/dbConfigFile.js');
const { AppError } = await import('../../app/errors/AppError.js');
const { DbSwitchService } = await import('../../app/services/dbSwitchService.js');
const { categoryRepository } = await import('../../app/repositories/categoryRepository.js');
const { entryRepository } = await import('../../app/repositories/entryRepository.js');
const { sessionRepository } = await import('../../app/repositories/sessionRepository.js');
const { userRepository } = await import('../../app/repositories/userRepository.js');
const { maintenanceReason } = await import('../../app/web/middleware/maintenance.js');

const service = new DbSwitchService(dbManager);

const SOURCE = { driver: 'sqlite' as const, file: 'source.db' };
const TARGET = { driver: 'sqlite' as const, file: 'target.db' };

/** 把当前库重置成「有数据」的初始状态。 */
async function seedSource(): Promise<void> {
  await dbManager.connect(SOURCE);
  const db = dbManager.db();
  await runMigrations(db);
  for (const table of [
    'entry_tiers',
    'sessions',
    'verification_codes',
    'entries',
    'categories',
    'users',
    'settings'
  ] as const) {
    await db.deleteFrom(table).execute();
  }

  await categoryRepository.ensureMany(['Sword', 'Axe']);
  await userRepository.create({
    username: 'Root',
    email: 'root@example.com',
    passwordHash: 'hash',
    role: 'SuperAdmin',
    emailVerified: true
  });
  await entryRepository.create({
    player: 'Alpha',
    rank: 'SubtierGrandmaster',
    points: 1200,
    testServer: 'Pico #1',
    tiers: { Sword: 'HT1' }
  });
  await entryRepository.create({
    player: 'Beta',
    rank: 'SubtierMaster',
    points: 900,
    testServer: null,
    tiers: { Axe: 'LT3' }
  });
  await sessionRepository.set({
    sid: 'sid-before-switch',
    userId: null,
    data: '{}',
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  });
}

/** 清空目标库文件里的数据（保留结构）。 */
async function emptyTarget(): Promise<void> {
  const db = await createKysely(TARGET);
  await runMigrations(db);
  for (const table of [
    'entry_tiers',
    'sessions',
    'verification_codes',
    'entries',
    'categories',
    'users',
    'settings'
  ] as const) {
    await db.deleteFrom(table).execute();
  }
  await db.destroy();
}

beforeAll(async () => {
  await seedSource();
});

afterAll(async () => {
  await dbManager.close();
  await rm(DATA_DIR, { recursive: true, force: true });
});

beforeEach(async () => {
  await seedSource();
  await emptyTarget();
});

describe('探测目标库', () => {
  it('报告结构版本与各表行数', async () => {
    const probe = await service.probe(SOURCE);
    expect(probe.driver).toBe('sqlite');
    expect(probe.migrationVersion).toBe('001_init');
    expect(probe.schemaCurrent).toBe(true);
    expect(probe.rowCounts['entries']).toBe(2);
    expect(probe.rowCounts['users']).toBe(1);
    expect(probe.isEmpty).toBe(false);
  });

  it('空库被识别为可迁移目标', async () => {
    const probe = await service.probe(TARGET);
    expect(probe.isEmpty).toBe(true);
    expect(probe.schemaCurrent).toBe(true);
  });

  it('探测不改动任何状态', async () => {
    await service.probe(TARGET);
    expect(dbManager.currentConfig()).toEqual(SOURCE);
    expect(await entryRepository.count()).toBe(2);
  });

  it('路径越界的 SQLite 目标被拒绝', async () => {
    await expect(service.probe({ driver: 'sqlite', file: '../../etc/passwd.db' })).rejects.toThrow(
      AppError
    );
    // 扩展名不合法同样拒绝
    await expect(service.probe({ driver: 'sqlite', file: 'notes.txt' })).rejects.toThrow(AppError);
  });

  it('连不上的服务型数据库报 db_connect_failed', async () => {
    try {
      await service.probe({
        driver: 'postgres',
        host: '127.0.0.1',
        // 一个几乎不可能被占用的端口
        port: 59997,
        database: 'nope',
        user: 'nobody',
        password: '',
        ssl: false
      });
      throw new Error('预期抛出连接错误');
    } catch (error) {
      expect(AppError.is(error)).toBe(true);
      expect((error as InstanceType<typeof AppError>).code).toBe('db_connect_failed');
    }
  });
});

describe('迁移并切换', () => {
  it('把全部数据搬到目标库并切过去', async () => {
    const result = await service.switchTo(TARGET, 'migrate');

    expect(result.copied).toMatchObject({
      users: 1,
      categories: 2,
      entries: 2,
      entry_tiers: 2,
      settings: 0
    });
    expect(dbManager.currentConfig()).toEqual(TARGET);

    // 数据可从新库正常读出，定级关联也完整
    expect(await entryRepository.count()).toBe(2);
    const alpha = await entryRepository.findByPlayer('Alpha');
    expect(alpha?.tiers).toEqual({ Sword: 'HT1' });
    expect(alpha?.testServer).toBe('Pico #1');
    expect((await userRepository.findByUsername('Root'))?.role).toBe('SuperAdmin');
  });

  it('切换后会话被清空（要求重新登录）', async () => {
    await service.switchTo(TARGET, 'migrate');
    expect(await sessionRepository.count()).toBe(0);
  });

  it('目标库没有 SuperAdmin 时切换后补一个（否则清空会话就没人登得回来）', async () => {
    /*
     * 切库会清空全部会话。若目标库里没有任何 SuperAdmin，切完就没人能登回来，
     * 只能等下一次进程重启才会 seed。direct 模式只校验结构版本、完全不看用户，
     * 所以这条路径原来是敞开的；migrate 模式在源库也没有 SuperAdmin 时同样中招。
     */
    const root = await userRepository.findByUsername('Root');
    await userRepository.update(root!.id, { role: 'User' });
    expect(await userRepository.findFirstByRole('SuperAdmin')).toBeNull();

    await service.switchTo(TARGET, 'migrate');

    // ADMIN_USERNAME 未设时默认 'admin'
    const seeded = await userRepository.findByUsername('admin');
    expect(seeded?.role).toBe('SuperAdmin');
  });

  it('连接配置被写入 data/db-config.json', async () => {
    await service.switchTo(TARGET, 'migrate');

    expect(existsSync(DB_CONFIG_PATH)).toBe(true);
    expect(JSON.parse(readFileSync(DB_CONFIG_PATH, 'utf-8'))).toEqual(TARGET);
  });

  it('切换结束后维护模式已退出', async () => {
    await service.switchTo(TARGET, 'migrate');
    expect(maintenanceReason()).toBeNull();
  });

  it('目标库非空时拒绝迁移，且当前库不受影响', async () => {
    // 先往目标库塞一条数据
    const db = await createKysely(TARGET);
    await db
      .insertInto('categories')
      .values({ id: 'cat-x', name: 'X', name_lower: 'x', created_at: new Date().toISOString() })
      .execute();
    await db.destroy();

    try {
      await service.switchTo(TARGET, 'migrate');
      throw new Error('预期拒绝');
    } catch (error) {
      expect((error as InstanceType<typeof AppError>).code).toBe('db_target_not_empty');
    }

    // 指针没动，数据还在，维护模式也没留下
    expect(dbManager.currentConfig()).toEqual(SOURCE);
    expect(await entryRepository.count()).toBe(2);
    expect(maintenanceReason()).toBeNull();
  });

  it('目标连不上时保持使用当前库', async () => {
    try {
      await service.switchTo({ driver: 'sqlite', file: 'bad.txt' }, 'migrate');
      throw new Error('预期拒绝');
    } catch (error) {
      expect(AppError.is(error)).toBe(true);
    }

    expect(dbManager.currentConfig()).toEqual(SOURCE);
    expect(await entryRepository.count()).toBe(2);
  });
});

describe('直接切换（回切）', () => {
  it('目标已是本应用的库时不复制数据', async () => {
    // 先迁移过去，再切回来
    await service.switchTo(TARGET, 'migrate');
    expect(dbManager.currentConfig()).toEqual(TARGET);

    const result = await service.switchTo(SOURCE, 'direct');

    expect(result.copied).toEqual({});
    expect(dbManager.currentConfig()).toEqual(SOURCE);
    // 源库里原本的数据仍在
    expect(await entryRepository.count()).toBe(2);
  });

  it('目标已有数据也允许直接切换（不检查是否为空）', async () => {
    await service.switchTo(TARGET, 'migrate');
    // 此时 SOURCE 里有数据，direct 模式应当接受
    await expect(service.switchTo(SOURCE, 'direct')).resolves.toBeDefined();
  });
});

describe('并发保护', () => {
  it('同时发起两次切换时第二次被拒绝', async () => {
    const first = service.switchTo(TARGET, 'migrate');
    const second = service.switchTo(TARGET, 'migrate');

    await expect(second).rejects.toMatchObject({ code: 'db_switch_in_progress' });
    await first;
  });
});

describe('维护模式', () => {
  it('挡住写请求但放行读请求', async () => {
    const { createApp } = await import('../../app/app.js');
    const { enterMaintenance, exitMaintenance } =
      await import('../../app/web/middleware/maintenance.js');
    const app = createApp();

    enterMaintenance('测试');
    try {
      // 读请求照常
      expect((await request(app).get('/')).status).toBe(200);
      expect((await request(app).get('/api/v1/gamemodes')).status).toBe(200);

      // 写请求被挡（CSRF 之后才到维护检查，这里用不带令牌的请求也够验证顺序）
      const write = await request(app).post('/login').type('form').send({ identifier: 'x' });
      expect([403, 503]).toContain(write.status);
    } finally {
      exitMaintenance();
    }

    expect((await request(app).get('/')).status).toBe(200);
  });

  it('维护模式的 503 带 Retry-After', async () => {
    const { createApp } = await import('../../app/app.js');
    const { enterMaintenance, exitMaintenance } =
      await import('../../app/web/middleware/maintenance.js');
    const app = createApp();
    const agent = request.agent(app);

    // 先拿一个合法令牌：CSRF 检查排在维护检查之前，没有令牌会先被 403 挡掉
    const page = await agent.get('/login');
    const token = /name="_csrf" value="([^"]+)"/.exec(page.text)?.[1] ?? '';
    expect(token).not.toBe('');

    enterMaintenance('测试');
    try {
      const write = await agent
        .post('/login')
        .type('form')
        .send({ _csrf: token, identifier: 'x', password: 'y' });

      expect(write.status).toBe(503);
      // 维护是唯一有预期恢复时间的 503，值得告诉客户端什么时候回来
      expect(Number(write.headers['retry-after'])).toBeGreaterThan(0);
    } finally {
      exitMaintenance();
    }
  });
});

describe('数据库面板', () => {
  const PASSWORD = 'panel password';
  let app: Express;

  function csrfOf(html: string): string {
    const match = /name="_csrf" value="([^"]+)"/.exec(html);
    if (!match) throw new Error('页面里没有 CSRF 令牌');
    return match[1]!;
  }

  async function loginAs(username: string) {
    const agent = request.agent(app);
    const page = await agent.get('/login');
    await agent
      .post('/login')
      .type('form')
      .send({ _csrf: csrfOf(page.text), identifier: username, password: PASSWORD });
    return agent;
  }

  beforeEach(async () => {
    const bcrypt = await import('bcryptjs');
    const { createApp } = await import('../../app/app.js');
    app = createApp();

    const hash = await bcrypt.default.hash(PASSWORD, 4);
    await userRepository.update((await userRepository.findByUsername('Root'))!.id, {
      passwordHash: hash
    });
    await userRepository.create({
      username: 'Manager',
      email: 'manager@example.com',
      passwordHash: hash,
      role: 'Admin',
      emailVerified: true
    });
  });

  it('只有超级管理员能进', async () => {
    expect((await request(app).get('/admin/database')).status).toBe(302);
    expect((await (await loginAs('Manager')).get('/admin/database')).status).toBe(403);
    expect((await (await loginAs('Root')).get('/admin/database')).status).toBe(200);
  });

  it('展示当前连接与各表行数', async () => {
    const html = (await (await loginAs('Root')).get('/admin/database')).text;
    expect(html).toContain('sqlite:source.db');
    expect(html).toContain('001_init');
    expect(html).toContain('entries');
  });

  it('测试连接返回目标库状态，且不改变当前连接', async () => {
    const agent = await loginAs('Root');
    const page = await agent.get('/admin/database');

    const response = await agent
      .post('/admin/database/test')
      .type('form')
      .send({ _csrf: csrfOf(page.text), driver: 'sqlite', file: 'target.db' });

    expect(response.status).toBe(200);
    expect(response.text).toContain('连接成功');
    expect(dbManager.currentConfig()).toEqual(SOURCE);
  });

  it('测试非法路径时报错但不崩', async () => {
    const agent = await loginAs('Root');
    const page = await agent.get('/admin/database');

    const response = await agent
      .post('/admin/database/test')
      .type('form')
      .send({ _csrf: csrfOf(page.text), driver: 'sqlite', file: '../escape.db' });

    expect(response.text).toContain('SQLite 文件路径不合法');
    expect(dbManager.currentConfig()).toEqual(SOURCE);
  });

  /*
   * 这条守的是「切库后要求重新登录」在**操作者自己**身上也成立。
   *
   * 服务层清空 sessions 打在新库上，而当前请求的会话还活在内存里；只要处理函数
   * 之后再写它一次（setFlash 就是写），express-session 收尾时就会把它连同 user
   * 一起 upsert 回新库。migrate 模式下目标库是源库的副本、用户 id 照样查得到，
   * 于是管理员无缝保持登录，而 redirect 到 /login 又被 requireGuest 弹去 /account，
   * 那条成功提示在路上就被 attachContext 消费掉、谁也看不到。
   *
   * 断言必须跟到落地页：只看 302 的 Location 是 /login 是发现不了的。
   */
  it('切换成功后当前会话被销毁，成功提示能在登录页看到', async () => {
    const agent = await loginAs('Root');
    const page = await agent.get('/admin/database');

    const response = await agent
      .post('/admin/database/switch')
      .type('form')
      .send({
        _csrf: csrfOf(page.text),
        driver: 'sqlite',
        file: 'target.db',
        mode: 'migrate',
        confirmName: 'target.db'
      });

    expect(response.status).toBe(302);
    expect(response.headers['location']).toBe('/login');
    expect(dbManager.currentConfig()).toEqual(TARGET);

    const landing = await agent.get('/login');
    // 仍停留在登录页（没有被 requireGuest 弹走），说明登录态确实没了
    expect(landing.status).toBe(200);
    expect(landing.text).toContain('数据库已切换，请重新登录');
    expect(landing.text).toContain('name="identifier"');
  });

  it('确认短语不匹配时拒绝切换', async () => {
    const agent = await loginAs('Root');
    const page = await agent.get('/admin/database');

    await agent
      .post('/admin/database/switch')
      .type('form')
      .send({
        _csrf: csrfOf(page.text),
        driver: 'sqlite',
        file: 'target.db',
        mode: 'migrate',
        confirmName: '打错了'
      });

    // 指针未动
    expect(dbManager.currentConfig()).toEqual(SOURCE);
  });
});
