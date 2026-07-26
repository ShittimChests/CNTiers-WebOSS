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
 *
 * **令牌是惰性铸造的**：只有视图真的要渲染一个 POST 表单时才写进会话
 * （见 currentCsrfToken 与 middleware/context 的 getter）。这里不预先铸造，
 * 否则任何一次匿名 GET 都会改动会话，于 saveUninitialized:false 之下仍然
 * 落一行 sessions 并下发 Set-Cookie——爬虫每命中一个页面就是一次 INSERT，
 * 而且每个 HTML 响应都带 Set-Cookie，共享缓存全部失效。
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function csrfProtection(req: Request, res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }

  /*
   * expected 为空有两种来路，而**常见的那种是正常用户**：会话过期、进程重启、
   * 切库清会话、用户清了 cookie——此时请求确实来自本站渲染的表单，只是那份
   * 会话已经不在了。所以这条分支的出口文案必须说清怎么恢复（见 errorHandler
   * 的 CSRF_DETAIL），不能当成「不可能发生」。
   */
  const expected = req.session.csrfToken;
  const submitted = readToken(req);
  if (!expected || !submitted || !timingSafeEqualString(expected, submitted)) {
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

/**
 * 取当前会话的令牌，没有就铸造一个。
 *
 * 调用这个函数就等于「本次响应里会出现一个 POST 表单」——它会改动会话，
 * 从而建立会话行并下发 cookie。因此调用点只有两处视图上下文的 getter
 * （middleware/context.ts 的正常上下文与 middleware/errorHandler.ts 的
 * fallbackContext），不要在中间件里无条件调用。
 */
export function currentCsrfToken(req: Request): string {
  req.session.csrfToken ??= generateToken(32);
  return req.session.csrfToken;
}
