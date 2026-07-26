import { Router, type NextFunction, type Request, type Response } from 'express';
import { config } from '../../config/env.js';
import { AppError } from '../../errors/AppError.js';
import { categoryService } from '../../services/categoryService.js';
import { leaderboardService } from '../../services/leaderboardService.js';
import { settingsService } from '../../services/settingsService.js';
import { userService } from '../../services/userService.js';
import {
  categoryLookupSchema,
  categoryNameSchema,
  categoryRenameSchema,
  entrySchema,
  pageQuerySchema,
  parseTierPayload,
  quickEditSchema,
  settingsSchema
} from '../../utils/validation.js';
import { requireAdminOrAbove, requireSuperAdmin } from '../middleware/auth.js';
import { setFlash, viewContext } from '../middleware/context.js';
import type { MessageId } from '../shared/messages.js';
import { renderPage } from '../views/lib/render.js';
import { AdminEntriesPage } from '../views/pages/admin/Entries.js';
import {
  AdminCategoriesPage,
  AdminSettingsPage,
  AdminUsersPage
} from '../views/pages/admin/manage.js';

export const adminRouter = Router();

/**
 * 后台路由。
 *
 * 所有写操作走同一个 PRG 骨架：执行 → 成功/失败都转成 flash → 重定向。
 * 因此每个路由只剩「校验 + 一句业务调用」，旧站里那些逐个手写
 * `?error=code` 再让模板各自维护码表的样板全部消失。
 */

/** 统一的写操作出口。 */
function submit(
  req: Request,
  res: Response,
  next: NextFunction,
  redirectTo: string,
  action: () => Promise<MessageId>
): void {
  void (async () => {
    try {
      setFlash(req, 'success', await action());
    } catch (error) {
      // 非业务异常交给错误中间件；在 void async 里 throw 会挂起请求
      if (!AppError.is(error)) {
        next(error);
        return;
      }
      setFlash(req, 'error', error.code);
    }
    res.redirect(redirectTo);
  })();
}

/** 校验失败的统一出口。 */
function rejectInput(req: Request, res: Response, redirectTo: string): void {
  setFlash(req, 'error', 'invalid_input');
  res.redirect(redirectTo);
}

/** Express 的 params 值可能是数组（重复参数名），这里只接受单值。 */
function idParam(req: Request): string {
  const raw = req.params['id'];
  return typeof raw === 'string' ? raw : '';
}

function body(req: Request): Record<string, unknown> {
  return req.body as Record<string, unknown>;
}

// ---------- 条目 ----------

adminRouter.get('/admin', requireAdminOrAbove, (req, res, next) => {
  void (async () => {
    try {
      const { page } = pageQuerySchema.parse(req.query);
      const [paged, categories, stats] = await Promise.all([
        leaderboardService.listPaged(page),
        categoryService.listNames(),
        leaderboardService.stats()
      ]);

      renderPage(res, AdminEntriesPage({ ctx: viewContext(res), page: paged, categories, stats }));
    } catch (error) {
      next(error);
    }
  })();
});

adminRouter.post('/admin/entries', requireAdminOrAbove, (req, res, next) => {
  const parsed = entrySchema.safeParse(req.body);
  if (!parsed.success) return rejectInput(req, res, '/admin');

  submit(req, res, next, '/admin', async () => {
    await leaderboardService.create({ ...parsed.data, tiers: parseTierPayload(body(req)) });
    return 'admin.entry.created';
  });
});

adminRouter.post('/admin/entries/:id/update', requireAdminOrAbove, (req, res, next) => {
  const parsed = entrySchema.safeParse(req.body);
  if (!parsed.success) return rejectInput(req, res, '/admin');

  submit(req, res, next, '/admin', async () => {
    await leaderboardService.update(idParam(req), {
      ...parsed.data,
      tiers: parseTierPayload(body(req))
    });
    return 'admin.entry.updated';
  });
});

/** 快速编辑：只更新请求体里实际出现的字段，定级不受影响。 */
adminRouter.post('/admin/entries/:id/quick', requireAdminOrAbove, (req, res, next) => {
  const parsed = quickEditSchema.safeParse(req.body);
  if (!parsed.success) return rejectInput(req, res, '/admin');

  submit(req, res, next, '/admin', async () => {
    await leaderboardService.quickUpdate(idParam(req), parsed.data);
    return 'admin.entry.updated';
  });
});

adminRouter.post('/admin/entries/:id/delete', requireAdminOrAbove, (req, res, next) => {
  submit(req, res, next, '/admin', async () => {
    await leaderboardService.delete(idParam(req));
    return 'admin.entry.deleted';
  });
});

adminRouter.get('/admin/export', requireAdminOrAbove, (_req, res, next) => {
  void (async () => {
    try {
      const csv = await leaderboardService.exportCsv();
      const stamp = new Date().toISOString().slice(0, 10);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="subtier-${stamp}.csv"`);
      res.send(csv);
    } catch (error) {
      next(error);
    }
  })();
});

// ---------- 细分项目 ----------

adminRouter.get('/admin/categories', requireAdminOrAbove, (_req, res, next) => {
  void (async () => {
    try {
      renderPage(
        res,
        AdminCategoriesPage({ ctx: viewContext(res), categories: await categoryService.list() })
      );
    } catch (error) {
      next(error);
    }
  })();
});

adminRouter.post('/admin/categories/add', requireAdminOrAbove, (req, res, next) => {
  const parsed = categoryNameSchema.safeParse(req.body);
  if (!parsed.success) return rejectInput(req, res, '/admin/categories');

  submit(req, res, next, '/admin/categories', async () => {
    await categoryService.add(parsed.data.name);
    return 'admin.category.created';
  });
});

adminRouter.post('/admin/categories/rename', requireAdminOrAbove, (req, res, next) => {
  const parsed = categoryRenameSchema.safeParse(req.body);
  if (!parsed.success) return rejectInput(req, res, '/admin/categories');

  submit(req, res, next, '/admin/categories', async () => {
    await categoryService.rename(parsed.data.from, parsed.data.to);
    return 'admin.category.renamed';
  });
});

adminRouter.post('/admin/categories/delete', requireAdminOrAbove, (req, res, next) => {
  // 删除用不带字符集正则的 schema：目标是库里已有的项目，
  // 拿「新建时的字符集」去卡会让历史项目删不掉
  const parsed = categoryLookupSchema.safeParse(req.body);
  if (!parsed.success) return rejectInput(req, res, '/admin/categories');

  submit(req, res, next, '/admin/categories', async () => {
    await categoryService.remove(parsed.data.name);
    return 'admin.category.deleted';
  });
});

// ---------- 站点设置（SuperAdmin） ----------

adminRouter.get('/admin/settings', requireSuperAdmin, (_req, res, next) => {
  void (async () => {
    try {
      const [settings, microsoftReady, tenantInEffect] = await Promise.all([
        settingsService.get(),
        settingsService.isMicrosoftEnabled(),
        // 面板里那个输入框未必是实际生效的值：MS_OAUTH_TENANT 指定了具体租户时
        // 会接管它。不显式报出来的话，这个字段就是在撒谎
        settingsService.tenantInEffect()
      ]);

      renderPage(
        res,
        AdminSettingsPage({
          ctx: viewContext(res),
          settings,
          // secret 只从环境变量读，这里只报告是否就绪
          microsoftSecretPresent: config.microsoft.clientSecret.length > 0,
          microsoftReady,
          tenantInEffect
        })
      );
    } catch (error) {
      next(error);
    }
  })();
});

adminRouter.post('/admin/settings', requireSuperAdmin, (req, res, next) => {
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) return rejectInput(req, res, '/admin/settings');

  submit(req, res, next, '/admin/settings', async () => {
    await settingsService.save({
      registrationEnabled: parsed.data.registrationEnabled,
      oauthEnabled: parsed.data.oauthEnabled,
      oauthMicrosoft: { clientId: parsed.data.oauthClientId, tenant: parsed.data.oauthTenant }
    });
    return 'admin.settings.saved';
  });
});

// ---------- 用户管理（SuperAdmin） ----------

adminRouter.get('/admin/users', requireSuperAdmin, (req, res, next) => {
  void (async () => {
    try {
      renderPage(
        res,
        AdminUsersPage({
          ctx: viewContext(res),
          users: await userService.list(),
          currentUserId: req.session.user?.id ?? ''
        })
      );
    } catch (error) {
      next(error);
    }
  })();
});

adminRouter.post('/admin/users/:id/promote', requireSuperAdmin, (req, res, next) => {
  submit(req, res, next, '/admin/users', async () => {
    await userService.promote(idParam(req), req.session.user?.id ?? '');
    return 'admin.user.promoted';
  });
});

adminRouter.post('/admin/users/:id/demote', requireSuperAdmin, (req, res, next) => {
  submit(req, res, next, '/admin/users', async () => {
    await userService.demote(idParam(req), req.session.user?.id ?? '');
    return 'admin.user.demoted';
  });
});

adminRouter.post('/admin/users/:id/delete', requireSuperAdmin, (req, res, next) => {
  submit(req, res, next, '/admin/users', async () => {
    await userService.remove(idParam(req), req.session.user?.id ?? '');
    return 'admin.user.deleted';
  });
});
