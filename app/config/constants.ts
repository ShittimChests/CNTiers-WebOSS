/**
 * 全站行为常量。旧实现里这些值散落在路由与服务中（bcrypt cost 抄了 4 遍、
 * session TTL 有两种写法），这里收敛为唯一事实来源。
 */

/** 密码哈希强度。与旧数据兼容：历史哈希同为 cost 12。 */
export const BCRYPT_COST = 12;

/** 会话有效期 8 小时，与旧站一致。 */
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
export const SESSION_COOKIE_NAME = 'subtier.sid';

/** 邮箱验证码与密码重置码：6 位数字、5 分钟过期、5 次错误作废。 */
export const CODE_LENGTH = 6;
export const VERIFY_TTL_MS = 5 * 60 * 1000;
export const RESET_TTL_MS = 5 * 60 * 1000;
export const MAX_CODE_ATTEMPTS = 5;

/** 同一用户、同一用途两次发信之间的最小间隔。 */
export const MAIL_COOLDOWN_MS = 30 * 1000;

/** OAuth 授权态在会话中的存活时间。 */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/** 限流：登录、发信、公开 API 三条独立轨道。 */
export const RATE_LIMITS = {
  login: { windowMs: 15 * 60 * 1000, max: 10 },
  mail: { windowMs: 60 * 1000, max: 4 },
  api: { windowMs: 60 * 1000, max: 60 }
} as const;

/** 请求体上限，防止超大表单打满内存。 */
export const BODY_LIMIT = '20kb';

/** 后台条目列表每页条数。 */
export const ADMIN_PAGE_SIZE = 20;

/** 公开 API 的分页边界，契约的一部分，不可随意调整。 */
export const API_LIMITS = {
  rankingsLimit: { min: 1, max: 200, default: 50 },
  gamemodeCount: { min: 1, max: 50, default: 10 },
  /** 每个 gamemode 的 tier 分桶数量（"1".."5"）。 */
  tierBuckets: 5
} as const;

/** 公开 API 响应的缓存时长（秒）。 */
export const API_CACHE_SECONDS = 60;

/**
 * Cloudflare Tunnel 前置时的连接保持窗口：keepAlive 必须短于 headers 超时，
 * 否则 cloudflared 会在连接复用竞态下偶发 502。
 */
export const KEEP_ALIVE_TIMEOUT_MS = 120_000;
export const HEADERS_TIMEOUT_MS = 125_000;

/** 用户名与显示字段的长度边界，与旧站校验保持一致。 */
export const FIELD_LIMITS = {
  username: { min: 3, max: 32 },
  password: { min: 8, max: 128 },
  player: { min: 1, max: 32 },
  rank: { min: 1, max: 64 },
  points: { min: 0, max: 9999 },
  categoryName: { min: 1, max: 48 },
  tier: { max: 32 },
  testServer: { max: 64 },
  id: { max: 64 }
} as const;

export const ROLES = ['SuperAdmin', 'Admin', 'User'] as const;
export type Role = (typeof ROLES)[number];

/** 角色排序权重，用于用户列表展示。 */
export const ROLE_WEIGHT: Record<Role, number> = {
  SuperAdmin: 0,
  Admin: 1,
  User: 2
};

export const VERIFICATION_PURPOSES = ['verify_email', 'reset_password'] as const;
export type VerificationPurpose = (typeof VERIFICATION_PURPOSES)[number];
