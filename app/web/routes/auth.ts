import { Router, type Request, type Response } from 'express';
import { AppError } from '../../errors/AppError.js';
import { authService } from '../../services/authService.js';
import { settingsService } from '../../services/settingsService.js';
import { toPublicUser } from '../../types/domain.js';
import type { User } from '../../types/domain.js';
import {
  emailOnlySchema,
  loginSchema,
  registerSchema,
  resetSchema,
  verifyCodeSchema
} from '../../utils/validation.js';
import { requireGuest } from '../middleware/auth.js';
import { setFlash, viewContext } from '../middleware/context.js';
import { loginLimiter, mailLimiter } from '../middleware/rateLimits.js';
import { renderPage } from '../views/lib/render.js';
import { ForgotPage, LoginPage, RegisterPage, ResetPage, VerifyPage } from '../views/pages/auth.js';

export const authRouter = Router();

/**
 * 认证路由。
 *
 * 共同约定：
 *   - 表单校验失败与业务失败都**重新渲染当前页**并带错误，保留用户已填内容；
 *     成功则 PRG（重定向 + flash），避免刷新重复提交。
 *   - 涉及账号是否存在的响应保持恒定，不泄漏账号枚举信息。
 */

/** 登录成功后回跳的目标。只接受站内相对路径，避免开放重定向。 */
function safeNext(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  if (!raw.startsWith('/') || raw.startsWith('//')) return undefined;
  return raw;
}

/** 登录成功后重建会话，防会话固定攻击。 */
function startSession(req: Request, user: User): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.regenerate((error) => {
      if (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      req.session.user = toPublicUser(user);
      resolve();
    });
  });
}

// ---------- 登录 ----------

authRouter.get('/admin/login', (_req, res) => {
  // 旧站的后台登录入口，保留为重定向
  res.redirect('/login');
});

authRouter.get('/login', requireGuest, (req, res) => {
  renderPage(res, LoginPage({ ctx: viewContext(res), next: safeNext(req.query['next']) }));
});

authRouter.post('/login', loginLimiter, (req, res, next) => {
  void (async () => {
    const nextPath = safeNext(req.query['next']);
    const parsed = loginSchema.safeParse(req.body);

    if (!parsed.success) {
      // 格式不对时也用同一句话，避免暴露"哪个字段有问题"
      renderPage(
        res,
        LoginPage({ ctx: viewContext(res), error: '请输入账号与密码', next: nextPath }),
        400
      );
      return;
    }

    try {
      const user = await authService.login(parsed.data.identifier, parsed.data.password);
      await startSession(req, user);
      res.redirect(nextPath ?? '/');
    } catch (error) {
      if (!AppError.is(error)) {
        next(error);
        return;
      }
      // 未验证的账号引导去验证页，其余显示统一错误
      if (error.code === 'email_not_verified') {
        res.redirect(`/verify?email=${encodeURIComponent(parsed.data.identifier)}`);
        return;
      }
      renderPage(
        res,
        LoginPage({
          ctx: viewContext(res),
          error: error.message,
          next: nextPath,
          identifier: parsed.data.identifier
        }),
        error.status
      );
    }
  })();
});

/** 登出。GET 不允许——退出是状态变更。 */
function logout(req: Request, res: Response): void {
  req.session.destroy(() => {
    res.redirect('/');
  });
}

authRouter.post('/logout', logout);
// 旧站有两个逐字重复的登出路由；这里同一个处理函数注册两条路径
authRouter.post('/admin/logout', logout);

// ---------- 注册 ----------

authRouter.get('/register', requireGuest, (_req, res, next) => {
  void (async () => {
    try {
      const settings = await settingsService.get();
      if (!settings.registrationEnabled) {
        // 与旧站一致：关闭注册时该页不存在
        next(new AppError('registration_disabled'));
        return;
      }
      renderPage(res, RegisterPage({ ctx: viewContext(res) }));
    } catch (error) {
      next(error);
    }
  })();
});

authRouter.post('/register', mailLimiter, (req, res, next) => {
  void (async () => {
    const parsed = registerSchema.safeParse(req.body);
    const body = req.body as Record<string, unknown>;
    const values = {
      username: typeof body['username'] === 'string' ? body['username'] : '',
      email: typeof body['email'] === 'string' ? body['email'] : ''
    };

    if (!parsed.success) {
      renderPage(
        res,
        RegisterPage({
          ctx: viewContext(res),
          error: parsed.error.issues[0]?.message ?? '提交内容不合法',
          values
        }),
        400
      );
      return;
    }

    try {
      const user = await authService.register(parsed.data);
      setFlash(req, 'info', 'auth.codeSent');
      res.redirect(`/verify?email=${encodeURIComponent(user.email)}`);
    } catch (error) {
      // 非 AppError 交给错误中间件；在 void async 里 throw 会变成
      // 未处理的 rejection，请求就挂在那里了
      if (!AppError.is(error)) {
        next(error);
        return;
      }
      renderPage(
        res,
        RegisterPage({ ctx: viewContext(res), error: error.message, values }),
        error.status
      );
    }
  })();
});

// ---------- 邮箱验证 ----------

function emailFromQuery(req: Request): string {
  const raw = req.query['email'];
  return typeof raw === 'string' ? raw : '';
}

authRouter.get('/verify', (req, res) => {
  renderPage(res, VerifyPage({ ctx: viewContext(res), email: emailFromQuery(req) }));
});

authRouter.post('/verify', (req, res, next) => {
  void (async () => {
    const parsed = verifyCodeSchema.safeParse(req.body);
    if (!parsed.success) {
      const body = req.body as Record<string, unknown>;
      renderPage(
        res,
        VerifyPage({
          ctx: viewContext(res),
          email: typeof body['email'] === 'string' ? body['email'] : '',
          error: parsed.error.issues[0]?.message ?? '验证码格式不正确'
        }),
        400
      );
      return;
    }

    try {
      await authService.verifyEmail(parsed.data.email, parsed.data.code);
      setFlash(req, 'success', 'auth.verified');
      res.redirect('/login');
    } catch (error) {
      if (!AppError.is(error)) {
        next(error);
        return;
      }
      // 剩余次数由 meta 带出来，拼进提示
      const attemptsLeft = error.meta['attemptsLeft'];
      const suffix =
        typeof attemptsLeft === 'number' ? `，还有 ${String(attemptsLeft)} 次尝试机会` : '';
      renderPage(
        res,
        VerifyPage({
          ctx: viewContext(res),
          email: parsed.data.email,
          error: `${error.message}${suffix}`
        }),
        error.status
      );
    }
  })();
});

authRouter.post('/resend-verification', mailLimiter, (req, res, next) => {
  void (async () => {
    const parsed = emailOnlySchema.safeParse(req.body);
    const email = parsed.success ? parsed.data.email : '';

    if (!parsed.success) {
      renderPage(
        res,
        VerifyPage({ ctx: viewContext(res), email, error: '请输入有效的邮箱地址' }),
        400
      );
      return;
    }

    try {
      await authService.resendVerification(email);
      setFlash(req, 'info', 'auth.codeSent');
    } catch (error) {
      // 冷却中：告知剩余秒数，但仍回到验证页
      if (AppError.is(error) && error.code === 'cooldown_active') {
        const seconds = error.meta['remainingSeconds'];
        renderPage(
          res,
          VerifyPage({
            ctx: viewContext(res),
            email,
            error: `${error.message}（${typeof seconds === 'number' ? `${String(seconds)} 秒后可重试` : '稍后再试'}）`
          }),
          error.status
        );
        return;
      }
      next(error);
      return;
    }

    res.redirect(`/verify?email=${encodeURIComponent(email)}`);
  })();
});

// ---------- 忘记 / 重置密码 ----------

authRouter.get('/forgot', requireGuest, (_req, res) => {
  renderPage(res, ForgotPage({ ctx: viewContext(res) }));
});

authRouter.post('/forgot', mailLimiter, (req, res, next) => {
  void (async () => {
    const parsed = emailOnlySchema.safeParse(req.body);
    if (!parsed.success) {
      renderPage(res, ForgotPage({ ctx: viewContext(res), error: '请输入有效的邮箱地址' }), 400);
      return;
    }

    try {
      await authService.requestPasswordReset(parsed.data.email);
    } catch (error) {
      // 冷却是唯一需要告知用户的失败；其余（包括账号不存在）一律静默，
      // 否则响应差异就成了账号枚举的信道
      if (AppError.is(error) && error.code === 'cooldown_active') {
        renderPage(res, ForgotPage({ ctx: viewContext(res), error: error.message }), error.status);
        return;
      }
      if (!AppError.is(error)) {
        next(error);
        return;
      }
    }

    // 无论邮箱是否存在都走同一条路径
    res.redirect(`/reset?email=${encodeURIComponent(parsed.data.email)}`);
  })();
});

authRouter.get('/reset', requireGuest, (req, res) => {
  renderPage(res, ResetPage({ ctx: viewContext(res), email: emailFromQuery(req) }));
});

authRouter.post('/reset', (req, res, next) => {
  void (async () => {
    const parsed = resetSchema.safeParse(req.body);
    if (!parsed.success) {
      const body = req.body as Record<string, unknown>;
      renderPage(
        res,
        ResetPage({
          ctx: viewContext(res),
          email: typeof body['email'] === 'string' ? body['email'] : '',
          error: parsed.error.issues[0]?.message ?? '提交内容不合法'
        }),
        400
      );
      return;
    }

    try {
      await authService.resetPassword(parsed.data.email, parsed.data.code, parsed.data.password);
      setFlash(req, 'success', 'auth.passwordReset');
      res.redirect('/login');
    } catch (error) {
      if (!AppError.is(error)) {
        next(error);
        return;
      }
      const attemptsLeft = error.meta['attemptsLeft'];
      const suffix =
        typeof attemptsLeft === 'number' ? `，还有 ${String(attemptsLeft)} 次尝试机会` : '';
      renderPage(
        res,
        ResetPage({
          ctx: viewContext(res),
          email: parsed.data.email,
          error: `${error.message}${suffix}`
        }),
        error.status
      );
    }
  })();
});
