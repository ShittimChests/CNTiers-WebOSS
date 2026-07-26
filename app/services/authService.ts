import bcrypt from 'bcryptjs';
import { BCRYPT_COST } from '../config/constants.js';
import { AppError } from '../errors/AppError.js';
import { userRepository, type UserRepository } from '../repositories/userRepository.js';
import type { User } from '../types/domain.js';
import { mailer as defaultMailer, type Mailer } from './mail/mailer.js';
import { settingsService, type SettingsService } from './settingsService.js';
import { verificationService, type VerificationService } from './verificationService.js';

export interface RegisterInput {
  username: string;
  email: string;
  password: string;
}

/**
 * 「账号不存在」时用来消耗与真实校验等量时间的占位哈希。
 *
 * 必须是**真正的** bcrypt 哈希：bcryptjs 在 `hash.length !== 60` 时直接
 * resolve(false) 而不做任何计算，所以手写一个形似的假串等于让防枚举失效
 * （实测：合法 cost-12 哈希约 210ms，长度不对的假串 0.2ms，200ms 的差值
 * 足以从外部区分账号是否存在）。
 *
 * 按 cost 缓存，且只在第一次真正需要时才计算——放到模块加载或构造函数里
 * 会把 cost 12 的 300ms 压在启动路径上，那正是旧站 hashSync 的毛病。
 */
const placeholderHashes = new Map<number, Promise<string>>();

export function placeholderPasswordHash(cost: number): Promise<string> {
  let cached = placeholderHashes.get(cost);
  if (!cached) {
    cached = bcrypt.hash('subtier:no-such-account', cost);
    placeholderHashes.set(cost, cached);
  }
  return cached;
}

/**
 * 账号认证：登录、注册、邮箱验证、密码重置与修改。
 *
 * 两条从旧实现保留下来的语义，去掉任何一条都会造成回退：
 *   1. 防账号枚举——登录失败一律「账号或密码错误」，忘记密码一律成功响应。
 *   2. 发信成功才留下账号——注册时若邮件发不出去，不留下无法验证的幽灵账号。
 */
export class AuthService {
  constructor(
    private readonly users: UserRepository = userRepository,
    private readonly verification: VerificationService = verificationService,
    private readonly mailer: Mailer = defaultMailer,
    private readonly settings: SettingsService = settingsService,
    /** 可注入仅为让测试跑得快；生产一律用 BCRYPT_COST。 */
    private readonly bcryptCost: number = BCRYPT_COST
  ) {}

  /** 登录。identifier 可以是用户名或邮箱。 */
  async login(identifier: string, password: string): Promise<User> {
    const user = await this.users.findByIdentifier(identifier);

    // 用户不存在（或是无本地密码的 OAuth-only 账号）时也要走一次等价的
    // bcrypt 比较，避免用响应时间区分账号是否存在
    const hash = user?.passwordHash ?? (await placeholderPasswordHash(this.bcryptCost));
    const ok = await bcrypt.compare(password, hash);

    if (!user?.passwordHash || !ok) {
      throw new AppError('invalid_credentials');
    }

    // SuperAdmin 豁免：引导账号即使 emailVerified 异常也必须能登录，
    // 否则一旦数据出错就没人能进后台了
    if (!user.emailVerified && user.role !== 'SuperAdmin') {
      /*
       * 带上账号的真实邮箱：调用方要把人引到 /verify，而那个页面的邮箱字段是
       * readonly 的、且校验码是按邮箱查账号的。若回显登录时输入的 identifier，
       * 用用户名登录的人就会被送进一个死胡同——提交验证码报「已过期」，
       * 点「重新发送」报「请输入有效的邮箱地址」。
       *
       * 这不构成信息泄露：能走到这一步说明密码已经校验通过。
       */
      throw new AppError('email_not_verified', { meta: { email: user.email } });
    }

    return user;
  }

  /**
   * 注册。要求站点开放注册，且用户名与邮箱都未被占用。
   * 邮件发送失败会删除刚创建的账户后再抛出。
   */
  async register(input: RegisterInput): Promise<User> {
    const settings = await this.settings.get();
    if (!settings.registrationEnabled) {
      throw new AppError('registration_disabled');
    }

    const username = input.username.trim();
    const email = input.email.trim();

    if (await this.users.isUsernameTaken(username)) throw new AppError('username_taken');
    if (await this.users.isEmailTaken(email)) throw new AppError('email_taken');

    const user = await this.users.create({
      username,
      email,
      passwordHash: await bcrypt.hash(input.password, this.bcryptCost),
      role: 'User',
      emailVerified: false
    });

    try {
      const code = await this.verification.issue(user.id, 'verify_email');
      await this.mailer.sendVerificationCode(user.email, code, user.username);
    } catch (error) {
      // 账号与验证码分表存储，无法像旧实现那样"发成功再落库"；
      // 改为发失败即回滚，对外表现一致：不留下无法验证的账号
      await this.users.delete(user.id);
      throw error;
    }

    return user;
  }

  /** 重发验证码。已验证的账号不再发信，但对外不暴露这一点。 */
  async resendVerification(email: string): Promise<void> {
    const user = await this.users.findByEmail(email);
    if (!user || user.emailVerified) return;

    const code = await this.verification.issue(user.id, 'verify_email');
    await this.mailer.sendVerificationCode(user.email, code, user.username);
  }

  /** 校验邮箱验证码并置为已验证。 */
  async verifyEmail(email: string, code: string): Promise<User> {
    const user = await this.users.findByEmail(email);
    // 邮箱不存在时的错误与验证码过期相同，避免泄漏账号是否存在
    if (!user) throw new AppError('code_expired');

    await this.verification.consume(user.id, 'verify_email', code);
    return this.users.update(user.id, { emailVerified: true });
  }

  /**
   * 请求密码重置。
   *
   * 无论邮箱是否存在都静默返回——调用方随后一律 302 到 /reset?email=…，
   * 因此响应不泄漏账号是否存在。SuperAdmin 与 OAuth-only 账户也走空操作：
   * 前者只能通过改 env 重置，后者没有本地密码可重置。
   */
  async requestPasswordReset(email: string): Promise<void> {
    const user = await this.users.findByEmail(email);
    if (!user) return;
    if (user.role === 'SuperAdmin') return;
    if (!user.passwordHash) return;

    const code = await this.verification.issue(user.id, 'reset_password');
    await this.mailer.sendPasswordResetCode(user.email, code, user.username);
  }

  /** 用重置码设置新密码。成功时顺带把邮箱标记为已验证。 */
  async resetPassword(email: string, code: string, password: string): Promise<User> {
    const user = await this.users.findByEmail(email);
    if (!user) throw new AppError('code_expired');

    await this.verification.consume(user.id, 'reset_password', code);

    return this.users.update(user.id, {
      passwordHash: await bcrypt.hash(password, this.bcryptCost),
      // 能收到重置码即证明邮箱可达，与旧实现一致
      emailVerified: true
    });
  }

  /**
   * 修改密码。已有本地密码的必须提供当前密码；
   * OAuth-only 账户属于首次设置本地密码，无需当前密码。
   */
  async changePassword(
    userId: string,
    currentPassword: string | null,
    nextPassword: string
  ): Promise<User> {
    const user = await this.users.findById(userId);
    if (!user) throw new AppError('user_not_found');

    if (user.passwordHash) {
      if (!currentPassword) throw new AppError('current_password_wrong');
      const ok = await bcrypt.compare(currentPassword, user.passwordHash);
      if (!ok) throw new AppError('current_password_wrong');
    }

    return this.users.update(userId, {
      passwordHash: await bcrypt.hash(nextPassword, this.bcryptCost)
    });
  }
}

export const authService = new AuthService();
