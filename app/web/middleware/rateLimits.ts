import rateLimit from 'express-rate-limit';
import type { NextFunction, Request, Response } from 'express';
import { RATE_LIMITS } from '../../config/constants.js';

/**
 * 四条独立的限流轨道：
 *   - 登录：保护密码校验路径
 *   - 发信：保护注册 / 忘记密码 / 重发验证码（与按用户的 30 秒冷却叠加）
 *   - 验证码校验：保护 POST /verify 与 POST /reset。账号级的「5 次即作废」
 *     只按 (账号, 用途) 计数，挡不住「换一个邮箱各试一次」这种横向探测
 *   - 公开 API：保护对外读接口
 *
 * `validate: { trustProxy: false }` 关掉的是 express-rate-limit 自己的告警，
 * 不是关掉代理支持——真实客户端 IP 仍来自 X-Forwarded-For。这条告警之所以
 * 会出现，是因为应用信任代理；我们已把 trust proxy 收紧成恰好一跳。
 *
 * 存储用默认的内存实现：重启即清零。对这个规模的站点可以接受。
 */

export const loginLimiter = rateLimit({
  windowMs: RATE_LIMITS.login.windowMs,
  limit: RATE_LIMITS.login.max,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
  message: '登录尝试过多，请稍后再试'
});

export const mailLimiter = rateLimit({
  windowMs: RATE_LIMITS.mail.windowMs,
  limit: RATE_LIMITS.mail.max,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
  message: '邮件发送过于频繁，请 1 分钟后重试'
});

export const codeLimiter = rateLimit({
  windowMs: RATE_LIMITS.code.windowMs,
  limit: RATE_LIMITS.code.max,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
  message: '验证码尝试过于频繁，请稍后再试'
});

/** API 的 429 响应体与 Retry-After 都是契约的一部分。 */
export const apiLimiter = rateLimit({
  windowMs: RATE_LIMITS.api.windowMs,
  limit: RATE_LIMITS.api.max,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
  handler: (req: Request, res: Response) => {
    // express-rate-limit 把状态挂在 req.rateLimit 上，但类型声明需要显式引入
    const reset = (req as Request & { rateLimit?: { resetTime?: Date } }).rateLimit?.resetTime;
    const retryAfter = reset
      ? Math.max(1, Math.ceil((reset.getTime() - Date.now()) / 1000))
      : RATE_LIMITS.api.windowMs / 1000;
    res.setHeader('Retry-After', String(retryAfter));
    res.status(429).json({
      error: 'rate_limited',
      message: `too many requests, retry after ${String(retryAfter)} seconds`
    });
  }
});

/**
 * 手写 CORS：只有公开 API 需要跨域，而且只允许 GET。
 * 引 cors 包会为一个 5 行的需求增加一个依赖。
 */
export function apiCors(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  /*
   * Retry-After 与 RateLimit-* 都不在 CORS 的默认可读清单里，不显式暴露的话
   * 浏览器端的调用方只能读到 429 的响应体，读不到文档承诺的重试时间。
   */
  res.setHeader('Access-Control-Expose-Headers', 'Retry-After, RateLimit-Policy, RateLimit');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
}
