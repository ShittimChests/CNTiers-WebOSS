import {
  MAIL_COOLDOWN_MS,
  MAX_CODE_ATTEMPTS,
  RESET_TTL_MS,
  VERIFY_TTL_MS,
  type VerificationPurpose
} from '../config/constants.js';
import { config } from '../config/env.js';
import { AppError } from '../errors/AppError.js';
import {
  verificationCodeRepository,
  type VerificationCodeRepository
} from '../repositories/verificationCodeRepository.js';
import {
  deriveKey,
  generateNumericCode,
  hmacCode,
  timingSafeEqualString
} from '../utils/tokens.js';

const TTL_BY_PURPOSE: Record<VerificationPurpose, number> = {
  verify_email: VERIFY_TTL_MS,
  reset_password: RESET_TTL_MS
};

/**
 * 验证码的唯一实现。
 *
 * 旧代码里 /verify 与 /reset 各有一份逐行同构的状态机（过期判断 → 定时安全比较
 * → 计数 → 5 次作废），字段名换一套就复制一遍。这里收敛成 issue/consume 两个原语，
 * 两条路由退化为「查用户 → consume → 各自的成功动作」。
 *
 * 相比旧实现的另一处改动：验证码以 HMAC 落库而非明文。6 位数字的空间只有 10^6，
 * 明文存储意味着数据库一旦只读泄露就能直接冒用；HMAC 让离线还原不可行，
 * 在线爆破仍由 5 次锁死 + 5 分钟过期 + 30 秒冷却三重拦截。
 */
export class VerificationService {
  readonly #key: Buffer;

  constructor(
    private readonly repository: VerificationCodeRepository = verificationCodeRepository,
    secret: string = config.sessionSecret
  ) {
    this.#key = deriveKey(secret, 'verification-code');
  }

  /**
   * 签发新验证码并返回明文（仅用于立即发信，绝不落库）。
   * 冷却未过则抛 cooldown_active，meta 带剩余秒数。
   */
  async issue(userId: string, purpose: VerificationPurpose): Promise<string> {
    const existing = await this.repository.find(userId, purpose);
    if (existing) {
      const remaining = this.#remainingCooldownMs(existing.lastSentAt);
      if (remaining > 0) {
        throw new AppError('cooldown_active', {
          meta: { remainingSeconds: Math.ceil(remaining / 1000) }
        });
      }
    }

    const code = generateNumericCode();
    const now = Date.now();

    await this.repository.upsert({
      userId,
      purpose,
      codeHash: hmacCode(this.#key, code),
      expiresAt: new Date(now + TTL_BY_PURPOSE[purpose]).toISOString(),
      sentAt: new Date(now).toISOString()
    });

    return code;
  }

  /**
   * 校验并一次性消费验证码。
   *
   * 成功即删除记录 —— 验证码不可重放。失败按状态分流：
   *   过期 → code_expired（记录一并清掉，逼走"重新发送"路径）
   *   错误 → 计数 +1；达到上限则作废验证码并抛 code_locked，
   *          否则抛 code_invalid 并在 meta 带剩余次数
   */
  async consume(userId: string, purpose: VerificationPurpose, code: string): Promise<void> {
    const record = await this.repository.find(userId, purpose);
    if (!record) {
      throw new AppError('code_expired');
    }

    if (Date.parse(record.expiresAt) <= Date.now()) {
      await this.repository.delete(userId, purpose);
      throw new AppError('code_expired');
    }

    const candidate = hmacCode(this.#key, code.trim());
    if (!timingSafeEqualString(record.codeHash, candidate)) {
      const attempts = await this.repository.incrementAttempts(userId, purpose);
      if (attempts >= MAX_CODE_ATTEMPTS) {
        await this.repository.delete(userId, purpose);
        throw new AppError('code_locked');
      }
      throw new AppError('code_invalid', {
        meta: { attemptsLeft: MAX_CODE_ATTEMPTS - attempts }
      });
    }

    await this.repository.delete(userId, purpose);
  }

  /** 距离下次可发送还剩多少秒；0 表示现在就能发。 */
  async remainingCooldownSeconds(userId: string, purpose: VerificationPurpose): Promise<number> {
    const record = await this.repository.find(userId, purpose);
    if (!record) return 0;
    return Math.ceil(this.#remainingCooldownMs(record.lastSentAt) / 1000);
  }

  async clear(userId: string, purpose: VerificationPurpose): Promise<void> {
    await this.repository.delete(userId, purpose);
  }

  #remainingCooldownMs(lastSentAt: string): number {
    const elapsed = Date.now() - Date.parse(lastSentAt);
    if (Number.isNaN(elapsed)) return 0;
    return Math.max(0, MAIL_COOLDOWN_MS - elapsed);
  }
}

export const verificationService = new VerificationService();
