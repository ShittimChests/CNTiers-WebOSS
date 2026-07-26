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
// 已被 vi.mock 顶掉，拿到的是 FakeMailer 实例；用于对发信打桩
const { mailer } = await import('../../app/services/mail/mailer.js');
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

/**
 * 等一封邮件落地。
 *
 * /forgot 与 /resend-verification 刻意**不** await 发信（发信耗时会随账号是否
 * 存在而变，await 就是把枚举信道搬到响应耗时上），所以取码前必须等它完成。
 * 注册路径仍然是 await 的，那里用 lastCode 就够。
 */
async function waitForCode(kind: 'verify' | 'reset'): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const pool = fakeMailer.sent.filter((mail) => mail.kind === kind);
    const code = pool[pool.length - 1]?.code;
    if (code) return code;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`等待 ${kind} 邮件超时`);
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

  it('不含 POST 表单的匿名页面不铸造令牌，也不建立会话', async () => {
    /*
     * 令牌是惰性铸造的：只有视图真的要渲染 POST 表单时才写会话。
     * 若无条件铸造，任何一次匿名 GET（含 404）都会落一行 sessions 并下发
     * Set-Cookie——首页与 /api/docs 是被机器人反复命中的公开页，那意味着
     * 每次命中一次 INSERT，且所有 HTML 响应都不再可被共享缓存。
     */
    const plain = await request(app).get('/');
    expect(plain.status).toBe(200);
    expect(plain.text).not.toContain('name="_csrf"');
    expect(plain.headers['set-cookie']).toBeUndefined();

    const missing = await request(app).get('/no-such-page');
    expect(missing.status).toBe(404);
    expect(missing.headers['set-cookie']).toBeUndefined();

    // 有 POST 表单的页面才铸造令牌，也才建立会话
    const withForm = await request(app).get('/login');
    expect(withForm.text).toContain('name="_csrf"');
    expect(withForm.headers['set-cookie']).toBeDefined();

    const rows = await dbManager.db().selectFrom('sessions').selectAll().execute();
    expect(rows).toHaveLength(1);
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
    /*
     * 用**用户名**登录时，回跳的 email 参数必须是账号的真实邮箱，不能回显
     * identifier：/verify 的邮箱字段是 readonly 的，而验证码是按邮箱查账号的。
     * 回显用户名会把人送进一个死胡同——提交验证码报「验证码已过期」，
     * 点「没收到？重新发送」报「请输入有效的邮箱地址」（400），完全卡住。
     */
    expect(response.headers['location']).toBe('/verify?email=unverified%40example.com');

    // 落地页上确实能把流程走完（这才是死胡同的判据：验证码是按邮箱查账号的）
    const verifyPage = await agent.get('/verify?email=unverified@example.com');
    const verified = await agent
      .post('/verify')
      .type('form')
      .send({
        _csrf: csrfOf(verifyPage.text),
        email: 'unverified@example.com',
        code: lastCode('verify')
      });
    expect(verified.status).toBe(302);
    expect(verified.headers['location']).toBe('/login');

    // 「没收到？重新发送」也不再是校验失败（400「请输入有效的邮箱地址」）；
    // 注册刚发过一封，所以这次如实报冷却而不是假称「已发送」
    const resent = await agent
      .post('/resend-verification')
      .type('form')
      .send({ _csrf: csrfOf(verifyPage.text), email: 'unverified@example.com' });
    expect(resent.status).not.toBe(400);
    expect(resent.status).toBe(429);
    expect(resent.text).toContain('秒后可重试');
  });

  it('注册后立刻重发不会假称「已发送」', async () => {
    /*
     * 账号级冷却（30 秒）必须被吞掉才不泄漏账号存在性，于是这条路径实际发信
     * 0 封。若还照旧 flash「验证码已发送」，页面就是在对用户撒谎，而用户会去
     * 等一封永远不来的邮件。注册时一并盖上会话冷却，这里才能说真话。
     */
    const agent = agentWithOwnIp();
    const registerPage = await agent.get('/register');
    await agent
      .post('/register')
      .type('form')
      .send({
        _csrf: csrfOf(registerPage.text),
        username: 'Fresh',
        email: 'fresh@example.com',
        password: 'correct horse battery',
        passwordConfirm: 'correct horse battery'
      });
    expect(fakeMailer.sent.filter((m) => m.kind === 'verify')).toHaveLength(1);

    const verifyPage = await agent.get('/verify?email=fresh@example.com');
    const resent = await agent
      .post('/resend-verification')
      .type('form')
      .send({ _csrf: csrfOf(verifyPage.text), email: 'fresh@example.com' });

    expect(resent.status).toBe(429);
    expect(resent.text).toContain('秒后可重试');
    // 确实没有第二封
    expect(fakeMailer.sent.filter((m) => m.kind === 'verify')).toHaveLength(1);

    // 但把地址改成另一个（比如刚才打错了）不该被这条冷却挡住
    const other = await agent
      .post('/resend-verification')
      .type('form')
      .send({ _csrf: csrfOf(verifyPage.text), email: 'typo@example.com' });
    expect(other.status).toBe(302);
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

  /*
   * 反斜杠这一组是真实的绕过：浏览器会把 URL 里的 `\` 归一成 `/`，于是
   * `/\evil.example.com` 实际按 `//evil.example.com` 解析——协议相对 URL，
   * 直接跳出站外。只挡 `//` 前缀是不够的。`%5C` 由 Express 解码成反斜杠。
   */
  it.each([
    'https://evil.example.com',
    '//evil.example.com',
    '/\\evil.example.com',
    '/%5Cevil.example.com'
  ])('拒绝把 %s 当作回跳目标', async (next) => {
    await seedVerifiedUser();
    const agent = agentWithOwnIp();
    const page = await agent.get('/login');
    const response = await agent
      .post(`/login?next=${next}`)
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

  /**
   * 连发两次，把两条路径的响应**指纹**逐项比出来。
   *
   * 这里守的是三条真实的枚举信道：
   *   1. 账号级冷却（verification_codes.last_sent_at）只可能对真实存在的账号
   *      触发，把它渲染成 429 就等于回答了「这个邮箱注册过没有」；
   *   2. 发信耗时——存在的账号要等一次 Resend 往返，不存在的直接 return，
   *      所以路由必须**不 await** 发信（一个请求即可判定，比状态码信道更好用）；
   *   3. 正文差异——比状态码更隐蔽，比如冷却剩余秒数被发信耗时挤掉 1 秒。
   *
   * 指纹里刻意剔掉「回显的邮箱本身」：那是提交者自己给的值，不构成信道。
   */
  interface Fingerprint {
    status: number;
    location: string;
    /** 正文里与账号存在性可能相关的部分：把回显的邮箱与每会话令牌抹掉后的长度 */
    bodyShape: number;
    hasCooldownNotice: boolean;
  }

  function fingerprint(response: request.Response, email: string): Fingerprint {
    // 302 的默认正文里邮箱是 URL 编码过的，两种形式都要抹掉，
    // 否则长度差只是「邮箱本身长短不同」而不是信道
    const normalized = response.text
      .split(email)
      .join('<EMAIL>')
      .split(encodeURIComponent(email))
      .join('<EMAIL>')
      .replace(/name="_csrf" value="[^"]*"/g, 'CSRF');
    return {
      status: response.status,
      location: (response.headers['location'] ?? '').replace(encodeURIComponent(email), '<EMAIL>'),
      bodyShape: normalized.length,
      hasCooldownNotice: normalized.includes('秒后可重试')
    };
  }

  async function twoRounds(path: string, email: string): Promise<Fingerprint[]> {
    const agent = agentWithOwnIp();
    const page = await agent.get(path === '/forgot' ? '/forgot' : `/verify?email=${email}`);
    const token = csrfOf(page.text);
    const rounds: Fingerprint[] = [];
    for (let i = 0; i < 2; i += 1) {
      const response = await agent.post(path).type('form').send({ _csrf: token, email });
      rounds.push(fingerprint(response, email));
    }
    return rounds;
  }

  it('/forgot 两轮响应的指纹与账号是否存在无关', async () => {
    const bcrypt = await import('bcryptjs');
    await userRepository.create({
      username: 'Real',
      email: 'real@example.com',
      passwordHash: await bcrypt.default.hash('original password', 4),
      role: 'User',
      emailVerified: true
    });

    const known = await twoRounds('/forgot', 'real@example.com');
    const unknown = await twoRounds('/forgot', 'ghost@example.com');

    expect(known[0]).toEqual({
      status: 302,
      location: '/reset?email=<EMAIL>',
      bodyShape: known[0]!.bodyShape,
      hasCooldownNotice: false
    });
    // 逐字段相等——包括正文形状与是否出现冷却提示
    expect(known[0]).toEqual(unknown[0]);
    expect(known[1]).toEqual(unknown[1]);
    // 第二轮确实是被会话级冷却挡住的，不是两边都恰好成功
    expect(known[1]!.status).toBe(429);
    expect(known[1]!.hasCooldownNotice).toBe(true);
  });

  it('/resend-verification 两轮响应的指纹同样一致', async () => {
    const bcrypt = await import('bcryptjs');
    await userRepository.create({
      username: 'Pending',
      email: 'pending@example.com',
      passwordHash: await bcrypt.default.hash('original password', 4),
      role: 'User',
      // 未验证：这才会真的走到发信路径
      emailVerified: false
    });

    const known = await twoRounds('/resend-verification', 'pending@example.com');
    const unknown = await twoRounds('/resend-verification', 'ghost@example.com');

    expect(known[0]).toEqual(unknown[0]);
    expect(known[1]).toEqual(unknown[1]);
    expect(known[1]!.status).toBe(429);
  });

  it('发信不在响应路径上（否则耗时本身就是枚举信道）', async () => {
    /*
     * 不存在的邮箱在 authService 里直接 return（毫秒级），存在的要等一次
     * Resend 往返。只要路由还 await 发信，一个请求就能判定一个邮箱注册过没有
     * ——这比修掉的那条状态码信道更好用，因为不需要 cookie、不需要连发两次。
     * 这条用例用一个「慢邮件」把差值放大到肉眼可见，再断言它没有传导到响应上。
     */
    const bcrypt = await import('bcryptjs');
    await userRepository.create({
      username: 'Slow',
      email: 'slow@example.com',
      passwordHash: await bcrypt.default.hash('original password', 4),
      role: 'User',
      emailVerified: true
    });

    const DELAY_MS = 800;
    const spy = vi
      .spyOn(mailer, 'sendPasswordResetCode')
      .mockImplementation(() => new Promise((resolve) => setTimeout(resolve, DELAY_MS)));

    try {
      const timeOf = async (email: string): Promise<number> => {
        const agent = agentWithOwnIp();
        const page = await agent.get('/forgot');
        const token = csrfOf(page.text);
        const started = Date.now();
        await agent.post('/forgot').type('form').send({ _csrf: token, email });
        return Date.now() - started;
      };

      const existing = await timeOf('slow@example.com');
      const missing = await timeOf('ghost@example.com');

      // 两边都远快于一次「发信」，说明响应没有等发信完成
      expect(existing).toBeLessThan(DELAY_MS);
      expect(missing).toBeLessThan(DELAY_MS);
    } finally {
      spy.mockRestore();
    }
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
        code: await waitForCode('reset'),
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

  it('改密后别处的登录被踢掉，当前会话保留', async () => {
    /*
     * 「踢掉其它会话」这一半语义此前没有测试。而且实现原来是「删光该用户的
     * 全部会话，再靠后续写操作把当前会话复活」——那只在恰好又改动了会话
     * （比如设了一条 flash）时才成立：express-session 在 resave:false 下按
     * 加载时的哈希判断是否回写，赋一个内容相同的值不会触发保存。
     */
    const current = await loginAs('Member', 'original password');
    const elsewhere = await loginAs('Member', 'original password');
    expect((await elsewhere.get('/account')).status).toBe(200);

    const page = await current.get('/account');
    const changed = await current
      .post('/account/password')
      .type('form')
      .send({
        _csrf: csrfOf(page.text),
        currentPassword: 'original password',
        password: 'a new password',
        passwordConfirm: 'a new password'
      });
    expect(changed.status).toBe(302);

    // 当前浏览器还在
    expect((await current.get('/account')).status).toBe(200);

    // 另一处的登录已失效
    const kicked = await elsewhere.get('/account');
    expect(kicked.status).toBe(302);
    expect(kicked.headers['location']).toContain('/login');
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
