import { OAUTH_STATE_TTL_MS } from '../config/constants.js';
import { config } from '../config/env.js';
import { AppError } from '../errors/AppError.js';
import { userRepository, type UserRepository } from '../repositories/userRepository.js';
import type { User } from '../types/domain.js';
import {
  generatePkceVerifier,
  generateToken,
  pkceChallenge,
  timingSafeEqualString
} from '../utils/tokens.js';
import { settingsService, type SettingsService } from './settingsService.js';

const GRAPH_ME = 'https://graph.microsoft.com/v1.0/me';
const SCOPE = 'openid profile email User.Read';

/** 登录与绑定用不同的回调地址，避免两条流程在会话里互相冒充。 */
export type OauthMode = 'login' | 'link';

const CALLBACK_PATH: Record<OauthMode, string> = {
  login: '/auth/microsoft/callback',
  link: '/account/link/microsoft/callback'
};

/** 存进会话的授权态。verifier 是 PKCE 的秘密，只能留在服务端。 */
export interface OauthStash {
  state: string;
  verifier: string;
  redirectUri: string;
  mode: OauthMode;
  createdAt: number;
}

export interface MicrosoftProfile {
  subject: string;
  email: string;
  displayName: string;
}

interface TokenResponse {
  access_token?: string;
}

interface GraphProfile {
  id?: string;
  mail?: string | null;
  userPrincipalName?: string | null;
  displayName?: string | null;
}

function authority(tenant: string): string {
  return `https://login.microsoftonline.com/${tenant || 'common'}`;
}

/**
 * Microsoft OAuth。手写 PKCE 流程，不引 passport——延续项目既有取舍。
 *
 * 相比旧实现的主要变化：两个回调处理器里重复的 62 行（state 校验、过期检查、
 * code 交换、拉取 profile）收敛成 handleCallback 一个方法，登录与绑定各自
 * 只保留真正不同的那部分逻辑。
 */
export class OauthService {
  constructor(
    private readonly users: UserRepository = userRepository,
    private readonly settings: SettingsService = settingsService
  ) {}

  /** 三个条件缺一不可：设置开关、client_id、以及来自环境变量的 client_secret。 */
  isEnabled(): Promise<boolean> {
    return this.settings.isMicrosoftEnabled();
  }

  async #requireEnabled(): Promise<{ clientId: string; clientSecret: string; tenant: string }> {
    if (!(await this.isEnabled())) throw new AppError('oauth_disabled');
    return this.settings.microsoftConfig();
  }

  /** 构造授权 URL，同时产出需要存进会话的授权态。 */
  async buildAuthUrl(mode: OauthMode): Promise<{ url: string; stash: OauthStash }> {
    const { clientId, tenant } = await this.#requireEnabled();

    const verifier = generatePkceVerifier();
    const state = generateToken(16);
    const redirectUri = `${config.appBaseUrl}${CALLBACK_PATH[mode]}`;

    const params = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      response_mode: 'query',
      scope: SCOPE,
      state,
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: 'S256'
    });

    return {
      url: `${authority(tenant)}/oauth2/v2.0/authorize?${params.toString()}`,
      stash: { state, verifier, redirectUri, mode, createdAt: Date.now() }
    };
  }

  /**
   * 回调的公共部分：校验授权态 → 换 token → 拉取用户信息。
   *
   * mode 也参与校验：一个登录流程的 state 不能用来完成绑定流程，
   * 否则两条回调路径可以互相冒充。
   */
  async handleCallback(
    stash: OauthStash | undefined,
    query: { code?: string; state?: string },
    expectedMode: OauthMode
  ): Promise<MicrosoftProfile> {
    const { clientId, clientSecret, tenant } = await this.#requireEnabled();

    if (!stash || !query.code || !query.state) throw new AppError('oauth_state_invalid');
    if (stash.mode !== expectedMode) throw new AppError('oauth_state_invalid');
    if (!timingSafeEqualString(stash.state, query.state)) throw new AppError('oauth_state_invalid');
    if (Date.now() - stash.createdAt > OAUTH_STATE_TTL_MS)
      throw new AppError('oauth_state_invalid');

    const token = await this.#exchangeCode({
      code: query.code,
      verifier: stash.verifier,
      redirectUri: stash.redirectUri,
      clientId,
      clientSecret,
      tenant
    });

    return this.#fetchProfile(token);
  }

  /**
   * 登录流程：先按 Microsoft subject 找，再退回按邮箱找，都没有就建号。
   * 邮箱已属于另一个绑了别的 subject 的账号时拒绝，避免账号被劫持。
   */
  async loginWithMicrosoft(profile: MicrosoftProfile): Promise<User> {
    const bound = await this.users.findByOauth('microsoft', profile.subject);
    if (bound) return bound;

    const byEmail = await this.users.findByEmail(profile.email);
    if (byEmail) {
      if (byEmail.oauthSubject && byEmail.oauthSubject !== profile.subject) {
        throw new AppError('oauth_email_taken');
      }
      return this.users.update(byEmail.id, {
        oauthProvider: 'microsoft',
        oauthSubject: profile.subject,
        emailVerified: true
      });
    }

    return this.users.create({
      username: await this.#uniqueUsername(profile.displayName),
      email: profile.email,
      // OAuth-only 账户没有本地密码，解绑前必须先设置一个
      passwordHash: null,
      role: 'User',
      emailVerified: true,
      oauthProvider: 'microsoft',
      oauthSubject: profile.subject
    });
  }

  /**
   * 把 Microsoft 显示名规整成合法用户名，并在冲突时追加序号。
   * 旧实现用的是无上界的 `for (let i = 1; ; i++)`，每轮还要全表扫描。
   */
  async #uniqueUsername(displayName: string): Promise<string> {
    const base =
      displayName
        .normalize('NFKD')
        .replace(/[^A-Za-z0-9_-]/g, '')
        .slice(0, 24) || 'msuser';

    if (!(await this.users.isUsernameTaken(base))) return base;

    for (let suffix = 1; suffix <= 999; suffix += 1) {
      const candidate = `${base}${String(suffix)}`;
      if (!(await this.users.isUsernameTaken(candidate))) return candidate;
    }
    // 走到这里说明同名账号超过 999 个，用随机后缀兜底而不是无限循环
    return `${base}-${generateToken(4)}`;
  }

  async #exchangeCode(input: {
    code: string;
    verifier: string;
    redirectUri: string;
    clientId: string;
    clientSecret: string;
    tenant: string;
  }): Promise<string> {
    const body = new URLSearchParams({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.verifier,
      scope: SCOPE
    });

    let response: Response;
    try {
      response = await fetch(`${authority(input.tenant)}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body
      });
    } catch (cause) {
      throw new AppError('oauth_exchange_failed', { cause });
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      console.error(`[oauth] token 接口 ${String(response.status)}: ${detail.slice(0, 300)}`);
      throw new AppError('oauth_exchange_failed', { meta: { status: response.status } });
    }

    const token = (await response.json()) as TokenResponse;
    if (!token.access_token) throw new AppError('oauth_exchange_failed');
    return token.access_token;
  }

  async #fetchProfile(accessToken: string): Promise<MicrosoftProfile> {
    let response: Response;
    try {
      response = await fetch(GRAPH_ME, { headers: { Authorization: `Bearer ${accessToken}` } });
    } catch (cause) {
      throw new AppError('oauth_exchange_failed', { cause });
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      console.error(`[oauth] Graph /me ${String(response.status)}: ${detail.slice(0, 200)}`);
      throw new AppError('oauth_exchange_failed', { meta: { status: response.status } });
    }

    const profile = (await response.json()) as GraphProfile;
    const email = profile.mail ?? profile.userPrincipalName ?? null;

    if (!profile.id) throw new AppError('oauth_exchange_failed');
    // 没有邮箱就无法建立账号（邮箱是登录标识之一）
    if (!email) throw new AppError('oauth_no_email');

    return {
      subject: profile.id,
      email,
      displayName: profile.displayName ?? email.split('@')[0] ?? 'microsoft-user'
    };
  }
}

export const oauthService = new OauthService();
