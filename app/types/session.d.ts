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
  }
}
