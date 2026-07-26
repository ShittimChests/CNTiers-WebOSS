import bcrypt from 'bcryptjs';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app/app.js';
import { createKysely } from '../../app/db/dialects.js';
import { dbManager } from '../../app/db/manager.js';
import { runMigrations } from '../../app/db/migrator.js';
import { categoryRepository } from '../../app/repositories/categoryRepository.js';
import { entryRepository } from '../../app/repositories/entryRepository.js';
import { settingsRepository } from '../../app/repositories/settingsRepository.js';
import { userRepository } from '../../app/repositories/userRepository.js';
import { settingsService } from '../../app/services/settingsService.js';
import type { Role } from '../../app/config/constants.js';

let app: Express;
let ipCounter = 0;

/** 每个 agent 一个独立 IP，避免登录限流互相干扰。 */
function agentWithOwnIp() {
  ipCounter += 1;
  return request
    .agent(app)
    .set(
      'X-Forwarded-For',
      `10.2.${String(Math.floor(ipCounter / 200))}.${String(ipCounter % 200)}`
    );
}

function csrfOf(html: string): string {
  const match = /name="_csrf" value="([^"]+)"/.exec(html);
  if (!match) throw new Error('页面里没有 CSRF 令牌');
  return match[1]!;
}

const PASSWORD = 'test password';

async function makeUser(username: string, role: Role): Promise<string> {
  const user = await userRepository.create({
    username,
    email: `${username.toLowerCase()}@example.com`,
    passwordHash: await bcrypt.hash(PASSWORD, 4),
    role,
    emailVerified: true
  });
  return user.id;
}

/** 以指定用户登录，返回带会话的 agent。 */
async function loginAs(username: string) {
  const agent = agentWithOwnIp();
  const page = await agent.get('/login');
  await agent
    .post('/login')
    .type('form')
    .send({ _csrf: csrfOf(page.text), identifier: username, password: PASSWORD });
  return agent;
}

/** 取某个页面的 CSRF 令牌，用于随后的 POST。 */
async function tokenFrom(agent: ReturnType<typeof agentWithOwnIp>, path: string): Promise<string> {
  return csrfOf((await agent.get(path)).text);
}

beforeAll(async () => {
  const dbConfig = { driver: 'sqlite' as const, file: ':memory:' };
  await dbManager.switchTo(await createKysely(dbConfig), dbConfig);
  await runMigrations(dbManager.db());
  app = createApp();
});

afterAll(async () => {
  await dbManager.close();
});

beforeEach(async () => {
  const db = dbManager.db();
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
  settingsService.invalidate();
});

describe('后台权限', () => {
  beforeEach(async () => {
    await makeUser('Member', 'User');
    await makeUser('Manager', 'Admin');
    await makeUser('Root', 'SuperAdmin');
  });

  it('未登录访问后台被送去登录页', async () => {
    const response = await request(app).get('/admin');
    expect(response.status).toBe(302);
    expect(response.headers['location']).toContain('/login');
  });

  it('普通用户访问后台被拒绝', async () => {
    const agent = await loginAs('Member');
    expect((await agent.get('/admin')).status).toBe(403);
    expect((await agent.get('/admin/categories')).status).toBe(403);
  });

  it('管理员可进条目与项目管理，但进不了设置与用户管理', async () => {
    const agent = await loginAs('Manager');
    expect((await agent.get('/admin')).status).toBe(200);
    expect((await agent.get('/admin/categories')).status).toBe(200);
    expect((await agent.get('/admin/settings')).status).toBe(403);
    expect((await agent.get('/admin/users')).status).toBe(403);
  });

  it('超级管理员可进全部页面', async () => {
    const agent = await loginAs('Root');
    for (const path of ['/admin', '/admin/categories', '/admin/settings', '/admin/users']) {
      expect((await agent.get(path)).status, path).toBe(200);
    }
  });

  it('普通用户的写操作也被拒绝', async () => {
    const agent = await loginAs('Member');
    const token = csrfOf((await agent.get('/account')).text);
    const response = await agent
      .post('/admin/entries')
      .type('form')
      .send({ _csrf: token, player: 'X', rank: 'Y', points: 1 });
    expect(response.status).toBe(403);
  });

  it('导航按角色显示后台入口', async () => {
    const member = await loginAs('Member');
    expect((await member.get('/')).text).not.toContain('href="/admin"');

    const manager = await loginAs('Manager');
    const managerHtml = (await manager.get('/')).text;
    expect(managerHtml).toContain('href="/admin"');
    expect(managerHtml).not.toContain('href="/admin/settings"');

    const root = await loginAs('Root');
    expect((await root.get('/')).text).toContain('href="/admin/settings"');
  });
});

describe('条目管理', () => {
  beforeEach(async () => {
    await makeUser('Manager', 'Admin');
    await categoryRepository.ensureMany(['Sword', 'Axe']);
  });

  it('新增条目，含细分项目定级', async () => {
    const agent = await loginAs('Manager');
    const token = await tokenFrom(agent, '/admin');

    const response = await agent.post('/admin/entries').type('form').send({
      _csrf: token,
      player: 'NewPlayer',
      rank: 'SubtierAce',
      points: '750',
      testServer: 'Pico Test #1',
      category__Sword: 'HT2',
      category__Axe: ''
    });

    expect(response.status).toBe(302);
    const entry = await entryRepository.findByPlayer('NewPlayer');
    expect(entry).not.toBeNull();
    expect(entry?.points).toBe(750);
    expect(entry?.testServer).toBe('Pico Test #1');
    // 空值表示未定级，不建行
    expect(entry?.tiers).toEqual({ Sword: 'HT2' });

    expect((await agent.get('/admin')).text).toContain('条目已添加');
  });

  /*
   * tier 的长度必须在服务端卡住。列是 varchar(32)，而 SQLite 不强制、PostgreSQL
   * 报错、MySQL 视 sql_mode 报错或静默截断——放行的话超长值会先安静地进 SQLite，
   * 等到日后 migrate 到 PostgreSQL 时才在复制事务里炸。视图上的 maxlength 是
   * 客户端属性，这个请求正是绕过它的那种。
   */
  it('超长的 tier 被拒绝，条目不落库', async () => {
    const agent = await loginAs('Manager');
    const token = await tokenFrom(agent, '/admin');

    const response = await agent
      .post('/admin/entries')
      .type('form')
      .send({
        _csrf: token,
        player: 'Overflow',
        rank: 'SubtierAce',
        points: '10',
        category__Sword: 'X'.repeat(33)
      });

    expect(response.status).toBe(302);
    expect(await entryRepository.findByPlayer('Overflow')).toBeNull();
    expect((await agent.get('/admin')).text).toContain('提交内容不合法');
  });

  it('刚好 32 字符的 tier 仍然接受（边界不能收紧）', async () => {
    const agent = await loginAs('Manager');
    const token = await tokenFrom(agent, '/admin');

    await agent
      .post('/admin/entries')
      .type('form')
      .send({
        _csrf: token,
        player: 'Edge',
        rank: 'SubtierAce',
        points: '10',
        category__Sword: 'X'.repeat(32)
      });

    expect((await entryRepository.findByPlayer('Edge'))?.tiers['Sword']).toHaveLength(32);
  });

  it('快速编辑只改指定字段，定级保留', async () => {
    const created = await entryRepository.create({
      player: 'Keeper',
      rank: 'SubtierMaster',
      points: 500,
      testServer: null,
      tiers: { Sword: 'HT1', Axe: 'LT2' }
    });

    const agent = await loginAs('Manager');
    const token = await tokenFrom(agent, '/admin');
    await agent
      .post(`/admin/entries/${created.id}/quick`)
      .type('form')
      .send({ _csrf: token, points: '1234', rank: 'SubtierMaster', testServer: '' });

    const updated = await entryRepository.findById(created.id);
    expect(updated?.points).toBe(1234);
    expect(updated?.tiers).toEqual({ Sword: 'HT1', Axe: 'LT2' });
  });

  it('完整编辑替换定级', async () => {
    const created = await entryRepository.create({
      player: 'Replacer',
      rank: 'SubtierAce',
      points: 300,
      testServer: null,
      tiers: { Sword: 'HT1', Axe: 'LT2' }
    });

    const agent = await loginAs('Manager');
    const token = await tokenFrom(agent, '/admin');
    await agent.post(`/admin/entries/${created.id}/update`).type('form').send({
      _csrf: token,
      player: 'Replacer',
      rank: 'SubtierGrandmaster',
      points: '2000',
      testServer: '',
      category__Sword: '',
      category__Axe: 'HT5'
    });

    const updated = await entryRepository.findById(created.id);
    expect(updated?.rank).toBe('SubtierGrandmaster');
    expect(updated?.tiers).toEqual({ Axe: 'HT5' });
  });

  it('删除条目', async () => {
    const created = await entryRepository.create({
      player: 'Doomed',
      rank: 'X',
      points: 1,
      testServer: null,
      tiers: {}
    });

    const agent = await loginAs('Manager');
    const token = await tokenFrom(agent, '/admin');
    await agent.post(`/admin/entries/${created.id}/delete`).type('form').send({ _csrf: token });

    expect(await entryRepository.findById(created.id)).toBeNull();
    expect((await agent.get('/admin')).text).toContain('条目已删除');
  });

  it('删除不存在的条目给出明确提示，而不是假装成功', async () => {
    const agent = await loginAs('Manager');
    const token = await tokenFrom(agent, '/admin');
    await agent.post('/admin/entries/entry-nope/delete').type('form').send({ _csrf: token });

    expect((await agent.get('/admin')).text).toContain('榜单条目不存在');
  });

  it('积分越界时拒绝并提示', async () => {
    const agent = await loginAs('Manager');
    const token = await tokenFrom(agent, '/admin');
    await agent
      .post('/admin/entries')
      .type('form')
      .send({ _csrf: token, player: 'Bad', rank: 'X', points: '99999' });

    expect(await entryRepository.count()).toBe(0);
    expect((await agent.get('/admin')).text).toContain('提交内容不合法');
  });

  it('导出 CSV 带 BOM 与下载头', async () => {
    await entryRepository.create({
      player: 'Exported',
      rank: 'SubtierAce',
      points: 640,
      testServer: null,
      tiers: { Sword: 'HT3' }
    });

    const agent = await loginAs('Manager');
    const response = await agent.get('/admin/export');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.headers['content-disposition']).toMatch(
      /attachment; filename="subtier-\d{4}-\d{2}-\d{2}\.csv"/
    );
    expect(response.text.startsWith('﻿')).toBe(true);
    expect(response.text).toContain('position,player,rank,points,testServer,Axe,Sword');
    expect(response.text).toContain('Exported');
  });
});

describe('细分项目管理', () => {
  beforeEach(async () => {
    await makeUser('Manager', 'Admin');
  });

  it('新增、改名与删除', async () => {
    const agent = await loginAs('Manager');

    let token = await tokenFrom(agent, '/admin/categories');
    await agent.post('/admin/categories/add').type('form').send({ _csrf: token, name: 'Bow' });
    expect(await categoryRepository.listNames()).toEqual(['Bow']);

    token = await tokenFrom(agent, '/admin/categories');
    await agent
      .post('/admin/categories/rename')
      .type('form')
      .send({ _csrf: token, from: 'Bow', to: 'Long Bow' });
    expect(await categoryRepository.listNames()).toEqual(['Long Bow']);

    token = await tokenFrom(agent, '/admin/categories');
    await agent
      .post('/admin/categories/delete')
      .type('form')
      .send({ _csrf: token, name: 'Long Bow' });
    expect(await categoryRepository.listNames()).toEqual([]);
  });

  it('重名被拒绝并提示', async () => {
    await categoryRepository.ensureMany(['Sword']);
    const agent = await loginAs('Manager');
    const token = await tokenFrom(agent, '/admin/categories');

    await agent.post('/admin/categories/add').type('form').send({ _csrf: token, name: 'sword' });

    expect((await agent.get('/admin/categories')).text).toContain('该细分项目已存在');
    expect(await categoryRepository.listNames()).toEqual(['Sword']);
  });

  it('改名后条目上的定级自动跟随', async () => {
    await categoryRepository.ensureMany(['Sword']);
    const entry = await entryRepository.create({
      player: 'Follower',
      rank: 'X',
      points: 1,
      testServer: null,
      tiers: { Sword: 'HT1' }
    });

    const agent = await loginAs('Manager');
    const token = await tokenFrom(agent, '/admin/categories');
    await agent
      .post('/admin/categories/rename')
      .type('form')
      .send({ _csrf: token, from: 'Sword', to: 'Sword PvP' });

    expect((await entryRepository.findById(entry.id))?.tiers).toEqual({ 'Sword PvP': 'HT1' });
  });

  it('非法项目名被拒绝', async () => {
    const agent = await loginAs('Manager');
    const token = await tokenFrom(agent, '/admin/categories');
    await agent
      .post('/admin/categories/add')
      .type('form')
      .send({ _csrf: token, name: '带中文的项目名' });

    expect(await categoryRepository.listNames()).toEqual([]);
  });

  it('删除既有项目不受「新建时字符集」限制', async () => {
    /*
     * 库里的项目名来自旧数据，未必符合今天新建时的规则。删除与改名的**来源名**
     * 若也套用新建的字符集正则，这类历史项目在后台里就既删不掉也改不了
     * ——改名的 from 早就是不带正则的，删除此前漏了这一条。
     */
    await categoryRepository.ensureMany(['带中文的项目名']);
    const agent = await loginAs('Manager');
    const token = await tokenFrom(agent, '/admin/categories');

    await agent
      .post('/admin/categories/delete')
      .type('form')
      .send({ _csrf: token, name: '带中文的项目名' });

    expect(await categoryRepository.listNames()).toEqual([]);
    expect((await agent.get('/admin/categories')).text).toContain('细分项目已删除');
  });
});

describe('站点设置', () => {
  beforeEach(async () => {
    await makeUser('Root', 'SuperAdmin');
  });

  it('保存注册开关与 OAuth 配置', async () => {
    const agent = await loginAs('Root');
    const token = await tokenFrom(agent, '/admin/settings');

    await agent.post('/admin/settings').type('form').send({
      _csrf: token,
      registrationEnabled: 'on',
      oauthClientId: 'client-123',
      oauthTenant: 'contoso'
    });

    settingsService.invalidate();
    const saved = await settingsRepository.load();
    expect(saved.registrationEnabled).toBe(true);
    // 未勾选的复选框根本不出现在请求体里，应落为 false
    expect(saved.oauthEnabled).toBe(false);
    expect(saved.oauthMicrosoft).toEqual({ clientId: 'client-123', tenant: 'contoso' });
  });

  it('保存后注册入口立即生效', async () => {
    const agent = await loginAs('Root');
    const token = await tokenFrom(agent, '/admin/settings');
    await agent
      .post('/admin/settings')
      .type('form')
      .send({ _csrf: token, registrationEnabled: 'on', oauthClientId: '', oauthTenant: 'common' });

    expect((await request(app).get('/register')).status).toBe(200);
  });

  it('页面报告 Microsoft 是否就绪，且不回显 secret', async () => {
    const agent = await loginAs('Root');
    const html = (await agent.get('/admin/settings')).text;
    expect(html).toContain('MS_OAUTH_CLIENT_SECRET');
    expect(html).toContain('尚未就绪');
    expect(html).not.toContain('name="oauthClientSecret"');
  });

  it('页面报出实际生效的租户与它的来源', async () => {
    /*
     * 面板里的 Tenant 输入框未必是生效的那个：MS_OAUTH_TENANT 指定了具体租户时会
     * 接管它。不把生效值显示出来的话，这个字段就是在撒谎——而租户是安全控制项
     * （tenant=common 意味着接受任意 Azure 租户）。
     *
     * 测试环境没设 MS_OAUTH_TENANT，面板也没配，所以应当报「默认值，未做租户限制」。
     */
    const agent = await loginAs('Root');
    const html = (await agent.get('/admin/settings')).text;
    expect(html).toContain('当前生效的租户');
    expect(html).toContain('未做租户限制');
  });
});

describe('用户管理', () => {
  let rootId: string;
  let memberId: string;

  beforeEach(async () => {
    rootId = await makeUser('Root', 'SuperAdmin');
    memberId = await makeUser('Member', 'User');
  });

  it('提升与降级', async () => {
    const agent = await loginAs('Root');

    let token = await tokenFrom(agent, '/admin/users');
    await agent.post(`/admin/users/${memberId}/promote`).type('form').send({ _csrf: token });
    expect((await userRepository.findById(memberId))?.role).toBe('Admin');

    token = await tokenFrom(agent, '/admin/users');
    await agent.post(`/admin/users/${memberId}/demote`).type('form').send({ _csrf: token });
    expect((await userRepository.findById(memberId))?.role).toBe('User');
  });

  it('删除用户', async () => {
    const agent = await loginAs('Root');
    const token = await tokenFrom(agent, '/admin/users');
    await agent.post(`/admin/users/${memberId}/delete`).type('form').send({ _csrf: token });

    expect(await userRepository.findById(memberId)).toBeNull();
    expect((await agent.get('/admin/users')).text).toContain('用户已删除');
  });

  it('拒绝对自己操作', async () => {
    const agent = await loginAs('Root');
    const token = await tokenFrom(agent, '/admin/users');
    await agent.post(`/admin/users/${rootId}/delete`).type('form').send({ _csrf: token });

    expect(await userRepository.findById(rootId)).not.toBeNull();
    // SuperAdmin 保护先触发
    expect((await agent.get('/admin/users')).text).toContain('不能修改超级管理员');
  });

  it('拒绝修改另一个超级管理员', async () => {
    const otherSuper = await makeUser('Root2', 'SuperAdmin');
    const agent = await loginAs('Root');
    const token = await tokenFrom(agent, '/admin/users');
    await agent.post(`/admin/users/${otherSuper}/demote`).type('form').send({ _csrf: token });

    expect((await userRepository.findById(otherSuper))?.role).toBe('SuperAdmin');
    expect((await agent.get('/admin/users')).text).toContain('不能修改超级管理员');
  });

  it('被删用户的会话立即失效', async () => {
    const victim = await loginAs('Member');
    expect((await victim.get('/account')).status).toBe(200);

    const root = await loginAs('Root');
    const token = await tokenFrom(root, '/admin/users');
    await root.post(`/admin/users/${memberId}/delete`).type('form').send({ _csrf: token });

    // 旧站漏了这一步：删除用户后其旧会话仍能通过 requireAuth
    expect((await victim.get('/account')).headers['location']).toContain('/login');
  });

  it('列表标出自己与超级管理员，不给出操作按钮', async () => {
    const agent = await loginAs('Root');
    const html = (await agent.get('/admin/users')).text;
    expect(html).toContain('超级管理员不可修改');
    expect(html).toContain('提升为管理员');
  });
});
