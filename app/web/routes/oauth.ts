import { Router } from 'express';
import { AppError } from '../../errors/AppError.js';
import { oauthService } from '../../services/oauthService.js';
import { userService } from '../../services/userService.js';
import { toPublicUser } from '../../types/domain.js';
import { requireAuth } from '../middleware/auth.js';
import { setFlash } from '../middleware/context.js';

export const oauthRouter = Router();

/**
 * 取单值查询参数。
 *
 * 重复参数名（`?state=a&state=b`）会让 Express 给出数组，`as string` 断言在
 * 这里是不成立的。返回 undefined 即落到既有的 oauth_state_invalid 分支，
 * 呈现为「重新发起登录」，而不是一个裸的类型错误。
 */
function singleQueryValue(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

/**
 * Microsoft OAuth。
 *
 * 登录与绑定用两条独立的回调地址，各自的授权态里记着 mode，回调时校验——
 * 否则一条流程的 state 就能拿去完成另一条流程。
 *
 * 两个回调里原本重复的 62 行（state 校验、过期检查、code 交换、拉取资料）
 * 已经收敛进 oauthService.handleCallback，这里只剩各自独有的分支。
 */

// ---------- 登录流程 ----------

oauthRouter.get('/auth/microsoft', (req, res, next) => {
  void (async () => {
    try {
      const { url, stash } = await oauthService.buildAuthUrl('login');
      req.session.oauthStash = stash;
      res.redirect(url);
    } catch (error) {
      next(error);
    }
  })();
});

oauthRouter.get('/auth/microsoft/callback', (req, res, next) => {
  void (async () => {
    const stash = req.session.oauthStash;
    delete req.session.oauthStash;

    try {
      const profile = await oauthService.handleCallback(
        stash,
        {
          code: singleQueryValue(req.query['code']),
          state: singleQueryValue(req.query['state'])
        },
        'login'
      );
      const user = await oauthService.loginWithMicrosoft(profile);

      // 防会话固定：登录成功后重建会话
      req.session.regenerate((error) => {
        if (error) {
          next(error);
          return;
        }
        req.session.user = toPublicUser(user);
        res.redirect('/');
      });
    } catch (error) {
      next(error);
    }
  })();
});

// ---------- 绑定流程 ----------

oauthRouter.get('/account/link/microsoft', requireAuth, (req, res, next) => {
  void (async () => {
    try {
      const { url, stash } = await oauthService.buildAuthUrl('link');
      req.session.oauthStash = stash;
      res.redirect(url);
    } catch (error) {
      // 站点未启用时不该给个 404 页面，回账户页说明情况更有用
      if (AppError.is(error) && error.code === 'oauth_disabled') {
        setFlash(req, 'error', 'oauth_disabled');
        res.redirect('/account');
        return;
      }
      next(error);
    }
  })();
});

oauthRouter.get('/account/link/microsoft/callback', requireAuth, (req, res, next) => {
  void (async () => {
    const stash = req.session.oauthStash;
    delete req.session.oauthStash;
    const user = req.session.user;
    if (!user) {
      res.redirect('/login');
      return;
    }

    try {
      const profile = await oauthService.handleCallback(
        stash,
        {
          code: singleQueryValue(req.query['code']),
          state: singleQueryValue(req.query['state'])
        },
        'link'
      );
      await userService.linkMicrosoft(user.id, profile.subject);
      setFlash(req, 'success', 'account.microsoftLinked');
    } catch (error) {
      if (!AppError.is(error)) {
        next(error);
        return;
      }
      setFlash(req, 'error', error.code);
    }
    res.redirect('/account');
  })();
});

oauthRouter.post('/account/unlink/microsoft', requireAuth, (req, res, next) => {
  void (async () => {
    const user = req.session.user;
    if (!user) {
      res.redirect('/login');
      return;
    }

    try {
      await userService.unlinkMicrosoft(user.id);
      setFlash(req, 'success', 'account.microsoftUnlinked');
    } catch (error) {
      if (!AppError.is(error)) {
        next(error);
        return;
      }
      setFlash(req, 'error', error.code);
    }
    res.redirect('/account');
  })();
});
