import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../../errors/AppError.js';
import { generateToken, timingSafeEqualString } from '../../utils/tokens.js';

/**
 * 同步令牌式 CSRF 防护，约 40 行手写实现。
 *
 * 替代已被上游废弃的 csurf。做法是标准的 synchronizer token pattern：
 * 会话里存一个随机令牌，所有状态变更请求必须在表单里回传同一个值，
 * 用定时安全比较校验。第二道防线是 SameSite=Lax 的会话 cookie。
 *
 * 令牌绑定会话而非单个表单，因此同一会话里打开多个标签页不会互相失效。
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function csrfProtection(req: Request, res: Response, next: NextFunction): void {
  req.session.csrfToken ??= generateToken(32);
  const expected = req.session.csrfToken;

  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }

  const submitted = readToken(req);
  if (!submitted || !timingSafeEqualString(expected, submitted)) {
    next(new AppError('csrf_invalid'));
    return;
  }

  next();
}

function readToken(req: Request): string | null {
  const body = req.body as Record<string, unknown> | undefined;
  const fromBody = body?.['_csrf'];
  if (typeof fromBody === 'string' && fromBody.length > 0) return fromBody;

  // 供 fetch 类请求使用（数据库连接测试面板会用到）
  const header = req.get('x-csrf-token');
  return header && header.length > 0 ? header : null;
}

/** 会话尚未建立时也要能拿到令牌，供视图渲染隐藏域。 */
export function currentCsrfToken(req: Request): string {
  req.session.csrfToken ??= generateToken(32);
  return req.session.csrfToken;
}
