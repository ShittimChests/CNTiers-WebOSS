import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Role } from '../../config/constants.js';
import { AppError } from '../../errors/AppError.js';
import { userRepository } from '../../repositories/userRepository.js';
import { toPublicUser, type PublicUser } from '../../types/domain.js';

/**
 * 权限中间件。所有需要鉴权的路由都用这里的三个导出，
 * 不要在处理函数里写内联的角色判断——那样规则会散落各处并逐渐失去一致。
 */

/**
 * 必须登录。
 *
 * 每次都回查数据库而不是只信会话快照：账号可能已被删除或降级。
 * 旧站的 requireAuth 只看 req.session.user 是否存在，
 * 于是已删除用户的旧会话仍能通行。
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  void (async () => {
    const sessionUser = req.session.user;
    if (!sessionUser) {
      // 登录后回到原来想去的页面
      const target = encodeURIComponent(req.originalUrl);
      res.redirect(`/login?next=${target}`);
      return;
    }

    try {
      const fresh = await userRepository.findById(sessionUser.id);
      if (!fresh) {
        // 账号已不存在：销毁会话并当作未登录
        req.session.destroy(() => {
          res.redirect('/login');
        });
        return;
      }

      // 角色或邮箱可能已被管理员改动，刷新快照
      req.session.user = toPublicUser(fresh);
      res.locals.ctx.user = req.session.user;
      next();
    } catch (error) {
      next(error);
    }
  })();
}

/** 要求特定角色之一。会先跑 requireAuth 的检查。 */
export function requireRole(...allowed: Role[]): RequestHandler {
  return (req, res, next) => {
    requireAuth(req, res, (error?: unknown) => {
      if (error) {
        next(error);
        return;
      }
      // requireAuth 可能已经重定向
      if (res.headersSent) return;

      const user: PublicUser | undefined = req.session.user;
      if (!user || !allowed.includes(user.role)) {
        next(new AppError('forbidden'));
        return;
      }
      next();
    });
  };
}

/** 榜单与细分项目的写操作。 */
export const requireAdminOrAbove = requireRole('Admin', 'SuperAdmin');

/** 站点设置、用户管理与数据库切换。 */
export const requireSuperAdmin = requireRole('SuperAdmin');

/** 已登录用户不该再看到登录/注册页。 */
export function requireGuest(req: Request, res: Response, next: NextFunction): void {
  if (req.session.user) {
    res.redirect('/account');
    return;
  }
  next();
}
