import type { NextFunction, Request, Response } from 'express';
import { config } from '../../config/env.js';
import { AppError } from '../../errors/AppError.js';
import { errorMessage } from '../../errors/codes.js';
import type { ViewContext } from '../../types/view.js';
import { currentCsrfToken } from './csrf.js';
import { renderPage } from '../views/lib/render.js';
import { ErrorPage } from '../views/pages/ErrorPage.js';

/**
 * 全站错误出口。
 *
 * 旧站有五套并存的错误处理方式，其中一套是「静默降级」：读设置失败就把
 * 注册与 OAuth 悄悄关掉且不留日志。这里只留两个出口：
 *   - 公开 API → JSON 信封 { error, message }，逐字段保持既有契约
 *   - 其余     → 渲染错误页
 * 5xx 一律记日志且不向用户暴露堆栈。
 */

const CSRF_DETAIL = '页面停留太久，安全令牌已经过期。请按 Ctrl+Shift+R 强制刷新后重新提交。';

function isApiRequest(req: Request): boolean {
  return req.path.startsWith('/api/v1');
}

/** 上下文中间件之前抛出的错误也要能渲染页面，这里给一个最小可用的上下文。 */
function fallbackContext(req: Request, res: Response): ViewContext {
  const existing: ViewContext | undefined = res.locals.ctx;
  if (existing) return existing;

  return {
    user: req.session?.user ?? null,
    csrfToken: req.session ? currentCsrfToken(req) : '',
    flash: null,
    settings: { registrationEnabled: false, microsoftReady: false },
    path: req.path
  };
}

export function notFoundHandler(req: Request, res: Response, next: NextFunction): void {
  next(new AppError('not_found', { meta: { path: `${req.method} ${req.originalUrl}` } }));
}

export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  const appError = AppError.is(error) ? error : null;
  const status = appError?.status ?? 500;

  if (status >= 500) {
    console.error('[error]', error);
  }

  if (res.headersSent) return;

  if (isApiRequest(req)) {
    const body = appError
      ? appError.toApiEnvelope()
      : { error: 'internal_error', message: errorMessage('internal_error') };
    res.status(status).type('application/json; charset=utf-8').send(JSON.stringify(body));
    return;
  }

  const ctx = fallbackContext(req, res);

  const title =
    status === 404
      ? '页面不存在'
      : status === 403
        ? '没有权限'
        : status >= 500
          ? '服务器出错了'
          : '请求有问题';

  const detail =
    appError?.code === 'csrf_invalid'
      ? CSRF_DETAIL
      : appError
        ? appError.message
        : config.isProduction
          ? errorMessage('internal_error')
          : // 开发环境把真实原因显示出来，省得去翻日志
            String(error);

  const unauthenticated = status === 401;

  renderPage(
    res,
    ErrorPage({
      ctx,
      title,
      detail,
      backHref: unauthenticated ? '/login' : '/',
      backLabel: unauthenticated ? '去登录' : '回到榜单'
    }),
    status
  );
}
