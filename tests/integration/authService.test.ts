import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../../app/errors/AppError.js';
import { placeholderPasswordHash } from '../../app/services/authService.js';
import { createServices, type TestServices } from '../helpers/services.js';
import { createTestDb, type TestDb } from '../helpers/testDb.js';

let db: TestDb;
let s: TestServices;

beforeAll(async () => {
  db = await createTestDb();
  s = createServices(db);
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.reset();
  s.mailer.clear();
  s.settings.invalidate();
  await s.settingsRepo.save({ registrationEnabled: true });
  s.settings.invalidate();
});

async function expectAppError(promise: Promise<unknown>, code: string): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    expect(AppError.is(error)).toBe(true);
    const appError = error as AppError;
    expect(appError.code).toBe(code);
    return appError;
  }
  throw new Error(`预期抛出 ${code}，但没有抛出`);
}

const newAccount = {
  username: 'Player1',
  email: 'player1@example.com',
  password: 'correct horse battery'
};

/** 走完注册 → 收码 → 验证的完整流程，返回用户。 */
async function registerAndVerify(): Promise<{ id: string }> {
  const user = await s.auth.register(newAccount);
  const code = s.mailer.lastCode('verify');
  if (!code) throw new Error('未收到验证码');
  await s.auth.verifyEmail(newAccount.email, code);
  return user;
}

describe('AuthService · 注册', () => {
  it('注册成功后账号未验证，并收到一封验证码邮件', async () => {
    const user = await s.auth.register(newAccount);

    expect(user.role).toBe('User');
    expect(user.emailVerified).toBe(false);
    expect(s.mailer.sent).toHaveLength(1);
    expect(s.mailer.sent[0]).toMatchObject({ to: newAccount.email, kind: 'verify' });
  });

  it('密码以哈希存储，明文不入库', async () => {
    const user = await s.auth.register(newAccount);
    expect(user.passwordHash).not.toBe(newAccount.password);
    expect(await bcrypt.compare(newAccount.password, user.passwordHash!)).toBe(true);
  });

  it('站点关闭注册时拒绝', async () => {
    await s.settingsRepo.save({ registrationEnabled: false });
    s.settings.invalidate();

    await expectAppError(s.auth.register(newAccount), 'registration_disabled');
    expect(await s.users.count()).toBe(0);
  });

  it('用户名与邮箱冲突分别报错（大小写不敏感）', async () => {
    await s.auth.register(newAccount);

    await expectAppError(
      s.auth.register({ ...newAccount, email: 'other@example.com', username: 'PLAYER1' }),
      'username_taken'
    );
    await expectAppError(
      s.auth.register({ ...newAccount, username: 'Other', email: 'PLAYER1@EXAMPLE.COM' }),
      'email_taken'
    );
  });

  it('发信失败时不留下无法验证的幽灵账号', async () => {
    const failing = {
      sendVerificationCode: () => Promise.reject(new AppError('mail_send_failed')),
      sendPasswordResetCode: () => Promise.resolve()
    };
    const { AuthService } = await import('../../app/services/authService.js');
    const auth = new AuthService(s.users, s.verification, failing, s.settings, s.bcryptCost);

    await expectAppError(auth.register(newAccount), 'mail_send_failed');
    // 这是旧实现「先发信再落库」所保证的语义，必须保留
    expect(await s.users.count()).toBe(0);
  });
});

describe('AuthService · 邮箱验证', () => {
  it('正确的验证码把账号标记为已验证', async () => {
    await s.auth.register(newAccount);
    const code = s.mailer.lastCode('verify')!;

    const verified = await s.auth.verifyEmail(newAccount.email, code);
    expect(verified.emailVerified).toBe(true);
  });

  it('不存在的邮箱与过期验证码返回同一个错误（不泄漏账号是否存在）', async () => {
    await expectAppError(s.auth.verifyEmail('nobody@example.com', '123456'), 'code_expired');
  });

  it('重发验证码会换一个新码，旧码失效', async () => {
    await s.auth.register(newAccount);
    const first = s.mailer.lastCode('verify')!;

    // 绕过 30 秒冷却：直接清掉记录再重发
    await s.verification.clear((await s.users.findByEmail(newAccount.email))!.id, 'verify_email');
    await s.auth.resendVerification(newAccount.email);
    const second = s.mailer.lastCode('verify')!;

    expect(second).not.toBe(first);
    await expectAppError(s.auth.verifyEmail(newAccount.email, first), 'code_invalid');
    await expect(s.auth.verifyEmail(newAccount.email, second)).resolves.toMatchObject({
      emailVerified: true
    });
  });

  it('对已验证账号重发时静默跳过，不发信', async () => {
    await registerAndVerify();
    s.mailer.clear();

    await expect(s.auth.resendVerification(newAccount.email)).resolves.toBeUndefined();
    expect(s.mailer.sent).toHaveLength(0);
  });

  it('对不存在的邮箱重发时静默跳过', async () => {
    await expect(s.auth.resendVerification('nobody@example.com')).resolves.toBeUndefined();
    expect(s.mailer.sent).toHaveLength(0);
  });
});

describe('AuthService · 登录', () => {
  it('已验证账号可用用户名或邮箱登录', async () => {
    await registerAndVerify();

    expect((await s.auth.login('Player1', newAccount.password)).username).toBe('Player1');
    expect((await s.auth.login('player1@example.com', newAccount.password)).username).toBe(
      'Player1'
    );
    // 标识符大小写不敏感
    expect((await s.auth.login('PLAYER1', newAccount.password)).username).toBe('Player1');
  });

  it('密码错误与账号不存在返回同一个错误（防枚举）', async () => {
    await registerAndVerify();

    const wrongPassword = await expectAppError(
      s.auth.login('Player1', 'wrong'),
      'invalid_credentials'
    );
    const noSuchUser = await expectAppError(s.auth.login('nobody', 'wrong'), 'invalid_credentials');
    expect(wrongPassword.message).toBe(noSuchUser.message);
  });

  it('占位哈希是真实的 bcrypt 哈希（否则防枚举会被长度短路掉）', async () => {
    const hash = await placeholderPasswordHash(s.bcryptCost);

    /*
     * 这条断言守的是一个具体的坑：bcryptjs 在 hash.length !== 60 时直接
     * resolve(false)，一次哈希运算都不做。旧实现的占位串是 65 字符的
     * '$2a$12$invalid…'，于是「账号不存在也走一次比较」形同虚设——实测
     * 长度不对的假串 0.2ms 返回，合法 cost-12 哈希约 210ms，200ms 的差值
     * 从外部就能区分账号是否存在。
     */
    expect(hash).toHaveLength(60);
    expect(hash.startsWith('$2')).toBe(true);
    expect(await bcrypt.compare('whatever', hash)).toBe(false);

    // 同一 cost 复用同一份，不在每次失败登录上重复付哈希开销
    expect(await placeholderPasswordHash(s.bcryptCost)).toBe(hash);
  });

  it('未验证账号被拒绝登录', async () => {
    await s.auth.register(newAccount);
    await expectAppError(s.auth.login('Player1', newAccount.password), 'email_not_verified');
  });

  it('SuperAdmin 即使未验证也能登录（否则数据出错就没人能进后台）', async () => {
    await s.users.create({
      username: 'root',
      email: 'root@local',
      passwordHash: await bcrypt.hash('rootpass', s.bcryptCost),
      role: 'SuperAdmin',
      emailVerified: false
    });

    expect((await s.auth.login('root', 'rootpass')).role).toBe('SuperAdmin');
  });

  it('OAuth-only 账号（无本地密码）无法用密码登录', async () => {
    await s.users.create({
      username: 'MsOnly',
      email: 'msonly@example.com',
      passwordHash: null,
      role: 'User',
      emailVerified: true,
      oauthProvider: 'microsoft',
      oauthSubject: 'subject-1'
    });

    await expectAppError(s.auth.login('MsOnly', 'anything'), 'invalid_credentials');
  });
});

describe('AuthService · 密码重置', () => {
  it('完整流程：请求 → 收码 → 重设 → 用新密码登录', async () => {
    await registerAndVerify();

    await s.auth.requestPasswordReset(newAccount.email);
    const code = s.mailer.lastCode('reset')!;
    expect(code).toMatch(/^\d{6}$/);

    await s.auth.resetPassword(newAccount.email, code, 'a brand new password');

    await expect(s.auth.login('Player1', 'a brand new password')).resolves.toMatchObject({
      username: 'Player1'
    });
    await expectAppError(s.auth.login('Player1', newAccount.password), 'invalid_credentials');
  });

  it('重置成功顺带把邮箱标记为已验证', async () => {
    await s.auth.register(newAccount);
    const user = (await s.users.findByEmail(newAccount.email))!;
    expect(user.emailVerified).toBe(false);

    await s.auth.requestPasswordReset(newAccount.email);
    const code = s.mailer.lastCode('reset')!;
    const updated = await s.auth.resetPassword(newAccount.email, code, 'new password here');

    expect(updated.emailVerified).toBe(true);
  });

  it('对不存在的邮箱静默返回，不发信', async () => {
    await expect(s.auth.requestPasswordReset('nobody@example.com')).resolves.toBeUndefined();
    expect(s.mailer.sent).toHaveLength(0);
  });

  it('SuperAdmin 不能通过邮件重置（只能改 env）', async () => {
    await s.users.create({
      username: 'root',
      email: 'root@example.com',
      passwordHash: 'hash',
      role: 'SuperAdmin',
      emailVerified: true
    });

    await expect(s.auth.requestPasswordReset('root@example.com')).resolves.toBeUndefined();
    expect(s.mailer.sent).toHaveLength(0);
  });

  it('OAuth-only 账号没有本地密码可重置', async () => {
    await s.users.create({
      username: 'MsOnly',
      email: 'msonly@example.com',
      passwordHash: null,
      role: 'User',
      emailVerified: true
    });

    await expect(s.auth.requestPasswordReset('msonly@example.com')).resolves.toBeUndefined();
    expect(s.mailer.sent).toHaveLength(0);
  });
});

describe('AuthService · 修改密码', () => {
  it('需要正确的当前密码', async () => {
    const user = await registerAndVerify();

    await expectAppError(
      s.auth.changePassword(user.id, 'wrong current', 'next password'),
      'current_password_wrong'
    );
    await expectAppError(
      s.auth.changePassword(user.id, null, 'next password'),
      'current_password_wrong'
    );

    await expect(
      s.auth.changePassword(user.id, newAccount.password, 'next password')
    ).resolves.toBeDefined();
    await expect(s.auth.login('Player1', 'next password')).resolves.toBeDefined();
  });

  it('OAuth-only 账号首次设置密码时无需当前密码', async () => {
    const user = await s.users.create({
      username: 'MsOnly',
      email: 'msonly@example.com',
      passwordHash: null,
      role: 'User',
      emailVerified: true
    });

    const updated = await s.auth.changePassword(user.id, null, 'first local password');
    expect(updated.passwordHash).not.toBeNull();
    await expect(s.auth.login('MsOnly', 'first local password')).resolves.toBeDefined();
  });

  it('用户不存在时报 user_not_found', async () => {
    await expectAppError(s.auth.changePassword('user-nope', null, 'x'), 'user_not_found');
  });
});
