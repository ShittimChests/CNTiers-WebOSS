import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAIL_COOLDOWN_MS, MAX_CODE_ATTEMPTS, VERIFY_TTL_MS } from '../../app/config/constants.js';
import { AppError } from '../../app/errors/AppError.js';
import { createServices, type TestServices } from '../helpers/services.js';
import { createTestDb, type TestDb } from '../helpers/testDb.js';

let db: TestDb;
let s: TestServices;
let userId: string;

beforeAll(async () => {
  db = await createTestDb();
  s = createServices(db);
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.reset();
  vi.useRealTimers();
  const user = await s.users.create({
    username: 'Tester',
    email: 'tester@example.com',
    passwordHash: null,
    role: 'User',
    emailVerified: false
  });
  userId = user.id;
});

/** 断言抛出的是带指定 code 的 AppError，并返回它以便检查 meta。 */
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

/**
 * 这套状态机在旧实现里存在两份逐行同构的拷贝（verify 与 reset 各一份），
 * 收敛成单一实现后，下面的测试同时覆盖了两条业务流程。
 */
describe('VerificationService', () => {
  it('签发 6 位数字验证码', async () => {
    const code = await s.verification.issue(userId, 'verify_email');
    expect(code).toMatch(/^\d{6}$/);
  });

  it('验证码以哈希形式落库，明文不可见', async () => {
    const code = await s.verification.issue(userId, 'verify_email');
    const stored = await s.codes.find(userId, 'verify_email');

    expect(stored).not.toBeNull();
    expect(stored?.codeHash).not.toBe(code);
    // HMAC-SHA256 的十六进制输出
    expect(stored?.codeHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('正确的验证码可消费一次，之后即失效（不可重放）', async () => {
    const code = await s.verification.issue(userId, 'verify_email');

    await expect(s.verification.consume(userId, 'verify_email', code)).resolves.toBeUndefined();
    expect(await s.codes.find(userId, 'verify_email')).toBeNull();

    await expectAppError(s.verification.consume(userId, 'verify_email', code), 'code_expired');
  });

  it('消费时容忍首尾空白（用户从邮件里复制常带空格）', async () => {
    const code = await s.verification.issue(userId, 'verify_email');
    await expect(
      s.verification.consume(userId, 'verify_email', `  ${code} `)
    ).resolves.toBeUndefined();
  });

  it('错误的验证码返回剩余尝试次数', async () => {
    await s.verification.issue(userId, 'verify_email');

    const error = await expectAppError(
      s.verification.consume(userId, 'verify_email', '000000'),
      'code_invalid'
    );
    expect(error.meta['attemptsLeft']).toBe(MAX_CODE_ATTEMPTS - 1);
  });

  it(`连续错 ${String(MAX_CODE_ATTEMPTS)} 次后验证码作废，正确的码也不再有效`, async () => {
    const code = await s.verification.issue(userId, 'verify_email');

    for (let attempt = 1; attempt < MAX_CODE_ATTEMPTS; attempt += 1) {
      await expectAppError(
        s.verification.consume(userId, 'verify_email', '000000'),
        'code_invalid'
      );
    }
    // 第 5 次错误触发锁定
    await expectAppError(s.verification.consume(userId, 'verify_email', '000000'), 'code_locked');

    expect(await s.codes.find(userId, 'verify_email')).toBeNull();
    await expectAppError(s.verification.consume(userId, 'verify_email', code), 'code_expired');
  });

  it('过期的验证码被拒绝并清除', async () => {
    const code = await s.verification.issue(userId, 'verify_email');

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + VERIFY_TTL_MS + 1000);

    await expectAppError(s.verification.consume(userId, 'verify_email', code), 'code_expired');
    expect(await s.codes.find(userId, 'verify_email')).toBeNull();
  });

  it('冷却期内不允许重新签发，并给出剩余秒数', async () => {
    await s.verification.issue(userId, 'verify_email');

    const error = await expectAppError(
      s.verification.issue(userId, 'verify_email'),
      'cooldown_active'
    );
    expect(error.meta['remainingSeconds']).toBeGreaterThan(0);
    expect(error.meta['remainingSeconds']).toBeLessThanOrEqual(MAIL_COOLDOWN_MS / 1000);
  });

  it('冷却结束后可重新签发，且尝试次数归零', async () => {
    await s.verification.issue(userId, 'verify_email');
    await expectAppError(s.verification.consume(userId, 'verify_email', '000000'), 'code_invalid');
    expect((await s.codes.find(userId, 'verify_email'))?.attempts).toBe(1);

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + MAIL_COOLDOWN_MS + 1000);

    const fresh = await s.verification.issue(userId, 'verify_email');
    expect((await s.codes.find(userId, 'verify_email'))?.attempts).toBe(0);
    await expect(s.verification.consume(userId, 'verify_email', fresh)).resolves.toBeUndefined();
  });

  it('两种用途互不干扰', async () => {
    const verifyCode = await s.verification.issue(userId, 'verify_email');
    const resetCode = await s.verification.issue(userId, 'reset_password');

    // 用途不同的码不能互换使用
    await expectAppError(s.verification.consume(userId, 'verify_email', resetCode), 'code_invalid');
    // 上一步的失败只影响 verify_email 的计数
    expect((await s.codes.find(userId, 'reset_password'))?.attempts).toBe(0);
    await expect(
      s.verification.consume(userId, 'reset_password', resetCode)
    ).resolves.toBeUndefined();
    await expect(
      s.verification.consume(userId, 'verify_email', verifyCode)
    ).resolves.toBeUndefined();
  });

  it('从未签发过时消费即报过期', async () => {
    await expectAppError(s.verification.consume(userId, 'verify_email', '123456'), 'code_expired');
  });

  it('remainingCooldownSeconds 在无记录时为 0', async () => {
    expect(await s.verification.remainingCooldownSeconds(userId, 'verify_email')).toBe(0);
    await s.verification.issue(userId, 'verify_email');
    expect(await s.verification.remainingCooldownSeconds(userId, 'verify_email')).toBeGreaterThan(
      0
    );
  });

  it('用不同密钥派生的服务无法消费对方签发的验证码', async () => {
    const { VerificationService } = await import('../../app/services/verificationService.js');
    const other = new VerificationService(s.codes, 'a-completely-different-secret');

    const code = await s.verification.issue(userId, 'verify_email');
    // 哈希基于派生密钥，换密钥即无法匹配——这正是数据库泄露时的防线
    await expectAppError(other.consume(userId, 'verify_email', code), 'code_invalid');
  });
});
