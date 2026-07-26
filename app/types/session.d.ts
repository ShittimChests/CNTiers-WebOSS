import type { VerificationPurpose } from '../config/constants.js';
import type { OauthStash } from '../services/oauthService.js';
import type { Flash } from '../web/shared/messages.js';
import type { PublicUser } from './domain.js';

/**
 * 会话上放什么，在这里一次说清。
 *
 * 只放 PublicUser 投影——密码哈希与令牌绝不进会话。
 */
declare module 'express-session' {
  interface SessionData {
    user?: PublicUser;
    flash?: Flash;
    /** CSRF 同步令牌，会话建立时生成。 */
    csrfToken?: string;
    /** Microsoft OAuth 的进行中授权态（含 PKCE verifier）。 */
    oauthStash?: OauthStash;
    /**
     * 发信类操作的会话级冷却：截止时间（epoch 毫秒）+ 当时提交的邮箱。
     *
     * 与 verification_codes.last_sent_at 的账号级冷却是两回事：那份用于真正
     * 限制发信，这份只用于给出**与账号是否存在无关**的提示，避免响应分叉
     * 泄漏账号存在性。记下邮箱是为了让「地址打错了、改正后重发」不必干等。
     */
    mailCooldown?: Partial<Record<VerificationPurpose, { until: number; email: string }>>;
  }
}
