import type { Express } from 'express';
import type * as MailerModule from '../../app/services/mail/mailer.js';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 发信是唯一会打到外部网络的边界，用 FakeMailer 顶掉。
 * mock 必须在被测模块之前生效，因此写在最上面（vitest 会自动提升）。
 */
const { fakeMailer } = vi.hoisted(() => {
  return { fakeMailer: { sent: [] as { to: string; code: string; kind: string }[] } };
});

vi.mock('../../app/services/mail/mailer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof MailerModule>();
  const instance = new actual.FakeMailer();
  // 把内部数组暴露给测试，便于取出验证码
  fakeMailer.sent = instance.sent;
  return { ...actual, mailer: instance };
});

const { createApp } = await import('../../app/app.js');
const { createKysely } = await import('../../app/db/dialects.js');
const { dbManager } = await import('../../app/db/manager.js');
const { runMigrations } = await import('../../app/db/migrator.js');
const { settingsRepository } = await import('../../app/repositories/settingsRepository.js');
const { userRepository } = await import('../../app/repositories/userRepository.js');
const { settingsService } = await import('../../app/services/settingsService.js');

let app: Express;

/**
 * 每个 agent 用独立的客户端 IP。
 *
 * 发信限流是按 IP 的（4 次 / 60 秒），若所有测试共用同一个 IP，
 * 前面的用例会把后面的用例限流掉。app 设了 trust proxy 1，
 * 因此 X-Forwarded-For 会被当作真实客户端地址。
 */
let ipCounter = 0;
function agentWithOwnIp() {
  ipCounter += 1;
  return request
    .agent(app)
    .set(
      'X-Forwarded-For',
      `10.1.${String(Math.floor(ipCounter / 200))}.${String(ipCounter % 200)}`
    );
}

/** 从渲染出的表单里取 CSRF 令牌。 */
function csrfOf(html: string): string {
  const match = /name="_csrf" value="([^"]+)"/.exec(html);
  if (!match) throw new Error('页面里没有 CSRF 令牌');
  return match[1]!;
}

function lastCode(kind: 'verify' | 'reset'): string {
  const pool = fakeMailer.sent.filter((mail) => mail.kind === kind);
  const code = pool[pool.length - 1]?.code;
  if (!code) throw new Error(`没有收到 ${kind} 邮件`);
  return code;
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
  for (const table of ['sessions', 'verification_codes', 'users', 'settings'] as const) {
    await db.deleteFrom(table).execute();
  }
  await settingsRepository.save({ registrationEnabled: true });
  settingsService.invalidate();
  fakeMailer.sent.length = 0;
});

describe('CSRF 防护', () => {
  it('缺少令牌的 POST 被拒绝', async () => {
    const response = await agentWithOwnIp().post('/login').type('form').send({
      identifier: 'someone',
      password: 'whatever'
    });
    expect(response.status).toBe(403);
    expect(response.text).toContain('安全令牌已经过期');
  });

  it('伪造的令牌被拒绝', async () => {
    const agent = agentWithOwnIp();
    await agent.get('/login');
    const response = await agent
      .post('/login')
      .type('form')
      .send({ _csrf: 'forged-token', identifier: 'someone', password: 'whatever' });
    expect(response.status).toBe(403);
  });

  it('GET 请求不需要令牌', async () => {
    expect((await request(app).get('/login')).status).toBe(200);
  });
});

describe('注册与验证流程', () => {
  it('走完注册 → 验证 → 登录', async () => {
    const agent = agentWithOwnIp();

    // 注册
    const registerPage = await agent.get('/register');
    expect(registerPage.status).toBe(200);
    const registered = await agent
      .post('/register')
      .type('form')
      .send({
        _csrf: csrfOf(registerPage.text),
        username: 'Player1',
        email: 'player1@example.com',
        password: 'correct horse battery',
        passwordConfirm: 'correct horse battery'
      });
    expect(registered.status).toBe(302);
    expect(registered.headers['location']).toBe('/verify?email=player1%40example.com');

    // 验证
    const verifyPage = await agent.get('/verify?email=player1@example.com');
    expect(verifyPage.text).toContain('验证邮箱');
    const verified = await agent
      .post('/verify')
      .type('form')
      .send({
        _csrf: csrfOf(verifyPage.text),
        email: 'player1@example.com',
        code: lastCode('verify')
      });
    expect(verified.status).toBe(302);
    expect(verified.headers['location']).toBe('/login');

    // 登录
    const loginPage = await agent.get('/login');
    const loggedIn = await agent
      .post('/login')
      .type('form')
      .send({
        _csrf: csrfOf(loginPage.text),
        identifier: 'Player1',
        password: 'correct horse battery'
      });
    expect(loggedIn.status).toBe(302);
    expect(loggedIn.headers['location']).toBe('/');

    // 会话已建立
    const account = await agent.get('/account');
    expect(account.status).toBe(200);
    expect(account.text).toContain('Player1');
  });

  it('注册关闭时页面不存在', async () => {
    await settingsRepository.save({ registrationEnabled: false });
    settingsService.invalidate();

    const response = await request(app).get('/register');
    expect(response.status).toBe(404);
  });

  it('密码不一致时重新渲染表单并保留已填内容', async () => {
    const agent = agentWithOwnIp();
    const page = await agent.get('/register');
    const response = await agent
      .post('/register')
      .type('form')
      .send({
        _csrf: csrfOf(page.text),
        username: 'Player1',
        email: 'player1@example.com',
        password: 'password-one',
        passwordConfirm: 'password-two'
      });

    expect(response.status).toBe(400);
    expect(response.text).toContain('两次输入的密码不一致');
    // 用户不必重新输入用户名与邮箱
    expect(response.text).toContain('value="Player1"');
    expect(response.text).toContain('value="player1@example.com"');
  });

  it('验证码错误时提示剩余次数', async () => {
    const agent = agentWithOwnIp();
    const page = await agent.get('/register');
    await agent
      .post('/register')
      .type('form')
      .send({
        _csrf: csrfOf(page.text),
        username: 'Player1',
        email: 'player1@example.com',
        password: 'correct horse battery',
        passwordConfirm: 'correct horse battery'
      });

    const verifyPage = await agent.get('/verify?email=player1@example.com');
    const response = await agent
      .post('/verify')
      .type('form')
      .send({ _csrf: csrfOf(verifyPage.text), email: 'player1@example.com', code: '000000' });

    expect(response.text).toContain('验证码不正确');
    expect(response.text).toContain('还有 4 次尝试机会');
  });
});

describe('登录', () => {
  async function seedVerifiedUser(): Promise<void> {
    const agent = agentWithOwnIp();
    const page = await agent.get('/register');
    await agent
      .post('/register')
      .type('form')
      .send({
        _csrf: csrfOf(page.text),
        username: 'Player1',
        email: 'player1@example.com',
        password: 'correct horse battery',
        passwordConfirm: 'correct horse battery'
      });
    const verifyPage = await agent.get('/verify?email=player1@example.com');
    await agent
      .post('/verify')
      .type('form')
      .send({
        _csrf: csrfOf(verifyPage.text),
        email: 'player1@example.com',
        code: lastCode('verify')
      });
  }

  it('密码错误与账号不存在给出同一句话', async () => {
    await seedVerifiedUser();
    const agent = agentWithOwnIp();
    const page = await agent.get('/login');
    const token = csrfOf(page.text);

    const wrongPassword = await agent
      .post('/login')
      .type('form')
      .send({ _csrf: token, identifier: 'Player1', password: 'wrong' });
    const noSuchUser = await agent
      .post('/login')
      .type('form')
      .send({ _csrf: token, identifier: 'ghost', password: 'wrong' });

    expect(wrongPassword.text).toContain('账号或密码错误');
    expect(noSuchUser.text).toContain('账号或密码错误');
  });

  it('未验证的账号被引导去验证页', async () => {
    const agent = agentWithOwnIp();
    const registerPage = await agent.get('/register');
    await agent
      .post('/register')
      .type('form')
      .send({
        _csrf: csrfOf(registerPage.text),
        username: 'Unverified',
        email: 'unverified@example.com',
        password: 'correct horse battery',
        passwordConfirm: 'correct horse battery'
      });

    const loginPage = await agent.get('/login');
    const response = await agent
      .post('/login')
      .type('form')
      .send({
        _csrf: csrfOf(loginPage.text),
        identifier: 'Unverified',
        password: 'correct horse battery'
      });

    expect(response.status).toBe(302);
    expect(response.headers['location']).toContain('/verify?email=');
  });

  it('登录后回到原本想访问的页面', async () => {
    await seedVerifiedUser();
    const agent = agentWithOwnIp();

    // 未登录访问受保护页面 → 带 next 跳登录
    const guarded = await agent.get('/account');
    expect(guarded.status).toBe(302);
    expect(guarded.headers['location']).toBe('/login?next=%2Faccount');

    const page = await agent.get('/login?next=%2Faccount');
    const response = await agent
      .post('/login?next=%2Faccount')
      .type('form')
      .send({ _csrf: csrfOf(page.text), identifier: 'Player1', password: 'correct horse battery' });

    expect(response.headers['location']).toBe('/account');
  });

  it('拒绝把外部地址当作回跳目标', async () => {
    await seedVerifiedUser();
    const agent = agentWithOwnIp();
    const page = await agent.get('/login');
    const response = await agent
      .post('/login?next=https://evil.example.com')
      .type('form')
      .send({ _csrf: csrfOf(page.text), identifier: 'Player1', password: 'correct horse battery' });

    expect(response.headers['location']).toBe('/');
  });

  it('已登录用户访问登录页会被送去账户页', async () => {
    await seedVerifiedUser();
    const agent = agentWithOwnIp();
    const page = await agent.get('/login');
    await agent
      .post('/login')
      .type('form')
      .send({ _csrf: csrfOf(page.text), identifier: 'Player1', password: 'correct horse battery' });

    const response = await agent.get('/login');
    expect(response.status).toBe(302);
    expect(response.headers['location']).toBe('/account');
  });

  it('登出后会话失效', async () => {
    await seedVerifiedUser();
    const agent = agentWithOwnIp();
    const page = await agent.get('/login');
    await agent
      .post('/login')
      .type('form')
      .send({ _csrf: csrfOf(page.text), identifier: 'Player1', password: 'correct horse battery' });

    const accountPage = await agent.get('/account');
    await agent
      .post('/logout')
      .type('form')
      .send({ _csrf: csrfOf(accountPage.text) });

    expect((await agent.get('/account')).headers['location']).toContain('/login');
  });
});

describe('忘记密码（防账号枚举）', () => {
  it('无论邮箱是否存在都重定向到同一个页面', async () => {
    const agent = agentWithOwnIp();
    const page = await agent.get('/forgot');
    const token = csrfOf(page.text);

    const unknown = await agent
      .post('/forgot')
      .type('form')
      .send({ _csrf: token, email: 'ghost@example.com' });

    expect(unknown.status).toBe(302);
    expect(unknown.headers['location']).toBe('/reset?email=ghost%40example.com');
    // 不存在的邮箱不该真的发出邮件
    expect(fakeMailer.sent.filter((m) => m.kind === 'reset')).toHaveLength(0);
  });

  it('存在的账号可以走完重置流程', async () => {
    // 先注册并验证一个账号
    const setup = agentWithOwnIp();
    const registerPage = await setup.get('/register');
    await setup
      .post('/register')
      .type('form')
      .send({
        _csrf: csrfOf(registerPage.text),
        username: 'Player1',
        email: 'player1@example.com',
        password: 'original password',
        passwordConfirm: 'original password'
      });
    const verifyPage = await setup.get('/verify?email=player1@example.com');
    await setup
      .post('/verify')
      .type('form')
      .send({
        _csrf: csrfOf(verifyPage.text),
        email: 'player1@example.com',
        code: lastCode('verify')
      });

    const agent = agentWithOwnIp();
    const forgotPage = await agent.get('/forgot');
    await agent
      .post('/forgot')
      .type('form')
      .send({ _csrf: csrfOf(forgotPage.text), email: 'player1@example.com' });

    const resetPage = await agent.get('/reset?email=player1@example.com');
    const reset = await agent
      .post('/reset')
      .type('form')
      .send({
        _csrf: csrfOf(resetPage.text),
        email: 'player1@example.com',
        code: lastCode('reset'),
        password: 'a brand new password',
        passwordConfirm: 'a brand new password'
      });

    expect(reset.status).toBe(302);
    expect(reset.headers['location']).toBe('/login');

    // 新密码可用
    const loginPage = await agent.get('/login');
    const loggedIn = await agent
      .post('/login')
      .type('form')
      .send({
        _csrf: csrfOf(loginPage.text),
        identifier: 'Player1',
        password: 'a brand new password'
      });
    expect(loggedIn.headers['location']).toBe('/');
  });
});

describe('账户中心', () => {
  async function loginAs(username: string, password: string) {
    const agent = agentWithOwnIp();
    const page = await agent.get('/login');
    await agent
      .post('/login')
      .type('form')
      .send({ _csrf: csrfOf(page.text), identifier: username, password });
    return agent;
  }

  beforeEach(async () => {
    const bcrypt = await import('bcryptjs');
    await userRepository.create({
      username: 'Member',
      email: 'member@example.com',
      passwordHash: await bcrypt.default.hash('original password', 4),
      role: 'User',
      emailVerified: true
    });
  });

  it('展示邮箱验证状态与密码状态', async () => {
    const agent = await loginAs('Member', 'original password');
    const response = await agent.get('/account');

    expect(response.status).toBe(200);
    expect(response.text).toContain('member@example.com');
    expect(response.text).toContain('已验证');
    expect(response.text).toContain('修改密码');
  });

  it('改密码需要正确的当前密码', async () => {
    const agent = await loginAs('Member', 'original password');
    const page = await agent.get('/account');

    const wrong = await agent
      .post('/account/password')
      .type('form')
      .send({
        _csrf: csrfOf(page.text),
        currentPassword: 'not the password',
        password: 'a new password',
        passwordConfirm: 'a new password'
      });
    expect(wrong.status).toBe(302);
    expect((await agent.get('/account')).text).toContain('当前密码不正确');
  });

  it('改密成功后当前会话保留，新密码可用', async () => {
    const agent = await loginAs('Member', 'original password');
    const page = await agent.get('/account');

    const changed = await agent
      .post('/account/password')
      .type('form')
      .send({
        _csrf: csrfOf(page.text),
        currentPassword: 'original password',
        password: 'a new password',
        passwordConfirm: 'a new password'
      });
    expect(changed.status).toBe(302);

    // 当前会话没被自己踢掉
    const after = await agent.get('/account');
    expect(after.status).toBe(200);
    expect(after.text).toContain('密码已更新');

    const other = await loginAs('Member', 'a new password');
    expect((await other.get('/account')).status).toBe(200);
  });

  it('未登录时访问账户页跳登录', async () => {
    const response = await request(app).get('/account');
    expect(response.status).toBe(302);
    expect(response.headers['location']).toContain('/login');
  });
});

describe('Microsoft OAuth（未启用时）', () => {
  it('登录入口返回 404', async () => {
    expect((await request(app).get('/auth/microsoft')).status).toBe(404);
  });

  it('登录页不显示 Microsoft 按钮', async () => {
    expect((await request(app).get('/login')).text).not.toContain('ms-button');
  });
});
