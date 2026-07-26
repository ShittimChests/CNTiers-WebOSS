import { Router } from 'express';
import { AppError } from '../../errors/AppError.js';
import { authService } from '../../services/authService.js';
import { userService } from '../../services/userService.js';
import { changePasswordSchema } from '../../utils/validation.js';
import { requireAuth } from '../middleware/auth.js';
import { setFlash, viewContext } from '../middleware/context.js';
import { renderPage } from '../views/lib/render.js';
import { AccountPage } from '../views/pages/Account.js';

export const accountRouter = Router();

accountRouter.get('/account', requireAuth, (req, res, next) => {
  void (async () => {
    try {
      const sessionUser = req.session.user!;
      const user = await userService.getById(sessionUser.id);

      renderPage(
        res,
        AccountPage({
          ctx: viewContext(res),
          account: {
            username: user.username,
            email: user.email,
            emailVerified: user.emailVerified,
            hasPassword: user.passwordHash !== null,
            microsoftLinked: user.oauthProvider === 'microsoft',
            role: user.role,
            createdAt: user.createdAt
          }
        })
      );
    } catch (error) {
      next(error);
    }
  })();
});

/**
 * 修改或首次设置本地密码。
 *
 * 成功后作废该用户的其它会话——改密码的常见动机就是怀疑凭据泄露，
 * 只改哈希而留着旧会话等于没改。当前会话保留，避免刚改完就被踢出去。
 */
accountRouter.post('/account/password', requireAuth, (req, res, next) => {
  void (async () => {
    const sessionUser = req.session.user!;
    const parsed = changePasswordSchema.safeParse(req.body);

    if (!parsed.success) {
      setFlash(req, 'error', 'invalid_input', {});
      res.redirect('/account');
      return;
    }

    try {
      const user = await userService.getById(sessionUser.id);
      const hadPassword = user.passwordHash !== null;

      await authService.changePassword(
        sessionUser.id,
        parsed.data.currentPassword ?? null,
        parsed.data.password
      );

      // 精确保留当前会话，而不是删光再指望后续写操作把它复活——
      // express-session 在 resave:false 下不会回写一个内容未变的会话
      const revoked = await userService.revokeSessions(sessionUser.id, req.sessionID);
      if (revoked > 0) {
        console.info(`已作废用户 ${user.username} 的 ${String(revoked)} 个其它会话。`);
      }

      setFlash(req, 'success', hadPassword ? 'account.passwordChanged' : 'account.passwordCreated');
      res.redirect('/account');
    } catch (error) {
      if (!AppError.is(error)) {
        next(error);
        return;
      }
      setFlash(req, 'error', error.code);
      res.redirect('/account');
    }
  })();
});
