import { Router, type Request, type Response } from 'express';
import { MAIL_COOLDOWN_MS, type VerificationPurpose } from '../../config/constants.js';
import { AppError } from '../../errors/AppError.js';
import { errorMessage, errorStatus } from '../../errors/codes.js';
import { authService } from '../../services/authService.js';
import { settingsService } from '../../services/settingsService.js';
import { userService } from '../../services/userService.js';
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
import { codeLimiter, loginLimiter, mailLimiter } from '../middleware/rateLimits.js';
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

/**
 * 登录成功后回跳的目标。只接受站内相对路径，避免开放重定向。
 *
 * 反斜杠必须一并拒绝：浏览器会把 URL 里的 `\` 归一成 `/`，于是 `/\evil.com`
 * 实际按 `//evil.com` 解析——协议相对 URL，直接跳出站外。只挡 `//` 前缀是不够的。
 */
function safeNext(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  if (!raw.startsWith('/') || raw.startsWith('//')) return undefined;
  if (raw.includes('\\')) return undefined;
  return raw;
}

/**
 * 把发信从响应路径上摘下来。
 *
 * 这一步是防枚举的**主要**手段，不是优化：不存在的邮箱在 authService 里直接
 * return（约 3ms），存在的要等一次 Resend 往返（实测约 1.2 秒）。只要还 await，
 * 一个请求就能判定一个邮箱注册过没有——比状态码信道更好用，因为它不需要
 * cookie、不需要连发两次、换 IP 也照样出结果。
 *
 * 发信结果对用户本来就不可见（对外一律「若该邮箱已注册…」），所以这里唯一
 * 要做的事是把失败记进日志——否则 Resend 挂掉、API key 轮换、EMAIL_FROM 未配
 * 都会变成静默空转，而这正是 errorHandler 的注释点名批判过的「静默降级」。
 */
function dispatchMail(what: string, work: Promise<unknown>): void {
  void work.catch((error: unknown) => {
    // 账号级冷却是正常状态（用户点太快），不是故障
    if (AppError.is(error) && error.code === 'cooldown_active') return;
    console.error(`[mail] ${what} 失败：`, error);
  });
}

/**
 * 发信类操作的会话级冷却。
 *
 * 存在的理由是安全而非限流：真正的冷却由 verificationService 按**账号**强制，
 * 但那条 cooldown_active 只可能对真实存在的账号触发，把它渲染出来就等于回答了
 * 「这个邮箱注册过没有」。所以对外只用这份与账号无关的会话级冷却给提示，
 * 账号级的 cooldown_active 一律吞掉。
 *
 * 它拦不住换会话重放（那由 mailLimiter 按 IP 兜），也不打算拦——它的职责只是
 * 让提示文案不依赖「账号是否存在」这个事实。
 *
 * 冷却连同**提交的邮箱**一起记：否则把地址打错的人改正后要干等 30 秒，
 * 而账号级冷却本来是按账号计的、改正后可以立刻发。按提交值判断不构成信道，
 * 因为它只取决于你自己刚填了什么。
 */
function mailCooldownSeconds(req: Request, purpose: VerificationPurpose, email: string): number {
  const entry = req.session.mailCooldown?.[purpose];
  if (entry?.email !== email.trim().toLowerCase()) return 0;
  return Math.max(0, Math.ceil((entry.until - Date.now()) / 1000));
}

function startMailCooldown(req: Request, purpose: VerificationPurpose, email: string): void {
  req.session.mailCooldown = {
    ...req.session.mailCooldown,
    [purpose]: { until: Date.now() + MAIL_COOLDOWN_MS, email: email.trim().toLowerCase() }
  };
}

/** 冷却中的统一提示文案，与账号是否存在无关。 */
function cooldownNotice(seconds: number): string {
  return `${errorMessage('cooldown_active')}（${String(seconds)} 秒后可重试）`;
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
      // 未验证的账号引导去验证页。email 取自账号本身而不是登录时输入的
      // identifier——用用户名登录的人否则会落进一个提交不了也重发不了的页面
      if (error.code === 'email_not_verified') {
        const email = error.meta['email'];
        const target = typeof email === 'string' ? email : parsed.data.identifier;
        res.redirect(`/verify?email=${encodeURIComponent(target)}`);
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
      // 注册确实发了一封，所以这里用的是断定式文案。同时盖上会话冷却：
      // 否则紧接着点「重新发送」会撞上账号级冷却、被吞掉，然后页面照样说
      // 「已发送」——那才是真的在撒谎
      startMailCooldown(req, 'verify_email', user.email);
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

authRouter.post('/verify', codeLimiter, (req, res, next) => {
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
      /*
       * 不拼「还有 N 次尝试机会」。剩余次数只对真实存在的账号才有，展示它就等于
       * 回答了「这个邮箱注册过没有」——配合三条码表文案已统一（见 errors/codes.ts），
       * 账号不存在 / 码过期 / 码错误对外是同一句话、同一状态码。
       */
      renderPage(
        res,
        VerifyPage({
          ctx: viewContext(res),
          email: parsed.data.email,
          error: error.message
        }),
        error.status
      );
    }
  })();
});

/*
 * 这个处理函数是**同步**的——发信不 await（见 dispatchMail），所以整条路径上
 * 没有任何需要等待的东西。写成 async 反而会引出「未 await 的 Promise 吞掉错误」
 * 那类问题，且 lint 会正确地指出没有 await。
 */
authRouter.post('/resend-verification', mailLimiter, (req, res) => {
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

  // 冷却判定必须早于业务调用，且只看会话——否则响应会随账号存在与否分叉
  const cooling = mailCooldownSeconds(req, 'verify_email', email);
  if (cooling > 0) {
    renderPage(
      res,
      VerifyPage({ ctx: viewContext(res), email, error: cooldownNotice(cooling) }),
      errorStatus('cooldown_active')
    );
    return;
  }
  startMailCooldown(req, 'verify_email', email);

  // 不 await：发信耗时会随「账号是否存在」变化，await 就等于把枚举信道
  // 从状态码搬到响应耗时上
  dispatchMail(`重发验证码 → ${email}`, authService.resendVerification(email));

  // 文案必须对两条路径都成立：邮箱不存在、已验证、或撞上账号级冷却时
  // 实际并没有发信，说「已发送」就是在对用户撒谎
  setFlash(req, 'info', 'auth.codeSentIfRegistered');
  res.redirect(`/verify?email=${encodeURIComponent(email)}`);
});

// ---------- 忘记 / 重置密码 ----------

authRouter.get('/forgot', requireGuest, (_req, res) => {
  renderPage(res, ForgotPage({ ctx: viewContext(res) }));
});

/** 同上，同步处理函数：发信已从响应路径上摘下来。 */
authRouter.post('/forgot', mailLimiter, (req, res) => {
  const parsed = emailOnlySchema.safeParse(req.body);
  if (!parsed.success) {
    renderPage(res, ForgotPage({ ctx: viewContext(res), error: '请输入有效的邮箱地址' }), 400);
    return;
  }

  // 冷却判定必须早于业务调用，且只看会话——账号级的冷却只会对真实存在的
  // 账号触发，渲染它就等于回答了「这个邮箱注册过没有」
  const cooling = mailCooldownSeconds(req, 'reset_password', parsed.data.email);
  if (cooling > 0) {
    renderPage(
      res,
      ForgotPage({ ctx: viewContext(res), error: cooldownNotice(cooling) }),
      errorStatus('cooldown_active')
    );
    return;
  }
  startMailCooldown(req, 'reset_password', parsed.data.email);

  // 不 await：见 dispatchMail 的说明。存在的账号要等一次 Resend 往返，
  // 不存在的直接 return，await 就把耗时变成了枚举信道
  dispatchMail(
    `密码重置码 → ${parsed.data.email}`,
    authService.requestPasswordReset(parsed.data.email)
  );

  // 无论邮箱是否存在都走同一条路径
  res.redirect(`/reset?email=${encodeURIComponent(parsed.data.email)}`);
});

authRouter.get('/reset', requireGuest, (req, res) => {
  renderPage(res, ResetPage({ ctx: viewContext(res), email: emailFromQuery(req) }));
});

authRouter.post('/reset', codeLimiter, (req, res, next) => {
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
      const user = await authService.resetPassword(
        parsed.data.email,
        parsed.data.code,
        parsed.data.password
      );

      /*
       * 作废该用户的全部会话。走到重置这条路的人往往正是因为已经失去对密码的
       * 控制，只改哈希而留着旧会话等于没改——这一点比「改密码」那条更硬。
       * 这里不传 exceptSid：此刻用户尚未登录，全清才是对的。
       */
      await userService.revokeSessions(user.id);

      setFlash(req, 'success', 'auth.passwordReset');
      res.redirect('/login');
    } catch (error) {
      if (!AppError.is(error)) {
        next(error);
        return;
      }
      // 同上：不展示剩余次数，否则就是账号枚举的判据
      renderPage(
        res,
        ResetPage({
          ctx: viewContext(res),
          email: parsed.data.email,
          error: error.message
        }),
        error.status
      );
    }
  })();
});
