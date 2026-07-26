import { Router, type Request } from 'express';
import { z } from 'zod';
import { DB_DRIVERS, SQLITE_MEMORY, type DbConnectionConfig } from '../../db/dialects.js';
import { AppError } from '../../errors/AppError.js';
import { dbSwitchService, type ConnectionProbe } from '../../services/dbSwitchService.js';
import { requireSuperAdmin } from '../middleware/auth.js';
import { setFlash, viewContext } from '../middleware/context.js';
import { renderPage } from '../views/lib/render.js';
import { AdminDatabasePage } from '../views/pages/admin/Database.js';

export const adminDatabaseRouter = Router();

/**
 * 数据库设置面板（仅 SuperAdmin）。
 *
 * 连接参数不落 session、不落数据库——每次提交都从表单重新读，
 * 密码只在这一次请求的生命周期里存在。
 */

const DEFAULT_PORTS: Record<string, number> = { postgres: 5432, mysql: 3306 };

const targetSchema = z.object({
  driver: z.enum(DB_DRIVERS),
  file: z.string().trim().max(128).optional(),
  host: z.string().trim().max(255).optional(),
  port: z.coerce.number().int().min(1).max(65535).optional(),
  database: z.string().trim().max(64).optional(),
  user: z.string().trim().max(64).optional(),
  password: z.string().max(255).optional(),
  ssl: z.string().optional(),
  sslInsecure: z.string().optional()
});

const switchSchema = targetSchema.extend({
  mode: z.enum(['migrate', 'direct']),
  confirmName: z.string().trim().min(1)
});

/** 表单值 → 连接配置。 */
function toConnectionConfig(input: z.infer<typeof targetSchema>): DbConnectionConfig {
  if (input.driver === 'sqlite') {
    const file = input.file ?? '';
    // 内存库只对测试有意义，切过去等于把数据扔掉
    if (file === SQLITE_MEMORY) throw new AppError('db_invalid_path', { meta: { file } });
    return { driver: 'sqlite', file };
  }

  if (!input.host || !input.database || !input.user) {
    throw new AppError('invalid_input', { meta: { missing: 'host/database/user' } });
  }

  const ssl = input.ssl === 'on';
  return {
    driver: input.driver,
    host: input.host,
    port: input.port ?? DEFAULT_PORTS[input.driver] ?? 5432,
    database: input.database,
    user: input.user,
    password: input.password ?? '',
    ssl,
    // 不开 TLS 时这个开关没有意义，别把它落进配置文件制造语义死区
    sslInsecure: ssl && input.sslInsecure === 'on'
  };
}

/** 目标库名，用于二次确认。 */
function targetName(config: DbConnectionConfig): string {
  return config.driver === 'sqlite' ? config.file : config.database;
}

/** 表单回填值。密码永不回填。 */
function formValues(req: Request): Record<string, string> {
  const body = req.body as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const key of ['driver', 'file', 'host', 'port', 'database', 'user', 'ssl', 'sslInsecure']) {
    const value = body[key];
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

/** 当前实际生效的连接（不是配置文件里写的那个）。 */
async function currentSnapshot() {
  const probe = await dbSwitchService.probeCurrent().catch(() => null);
  return {
    summary: probe?.summary ?? '（无法读取）',
    driver: probe?.driver ?? 'sqlite',
    migrationVersion: probe?.migrationVersion ?? null,
    rowCounts: probe?.rowCounts ?? {}
  };
}

adminDatabaseRouter.get('/admin/database', requireSuperAdmin, (_req, res, next) => {
  void (async () => {
    try {
      renderPage(
        res,
        AdminDatabasePage({ ctx: viewContext(res), current: await currentSnapshot() })
      );
    } catch (error) {
      next(error);
    }
  })();
});

/** 测试连接。只读，不改任何状态。 */
adminDatabaseRouter.post('/admin/database/test', requireSuperAdmin, (req, res, next) => {
  void (async () => {
    try {
      const parsed = targetSchema.safeParse(req.body);
      const current = await currentSnapshot();

      if (!parsed.success) {
        renderPage(
          res,
          AdminDatabasePage({
            ctx: viewContext(res),
            current,
            probeError: parsed.error.issues[0]?.message ?? '连接参数不合法',
            form: formValues(req)
          }),
          400
        );
        return;
      }

      let probe: ConnectionProbe | undefined;
      let probeError: string | undefined;
      try {
        probe = await dbSwitchService.probe(toConnectionConfig(parsed.data));
      } catch (error) {
        if (!AppError.is(error)) throw error;
        probeError = error.message;
      }

      renderPage(
        res,
        AdminDatabasePage({
          ctx: viewContext(res),
          current,
          probe,
          probeError,
          form: formValues(req)
        })
      );
    } catch (error) {
      next(error);
    }
  })();
});

/** 执行切换。失败时保持使用当前数据库。 */
adminDatabaseRouter.post('/admin/database/switch', requireSuperAdmin, (req, res, next) => {
  void (async () => {
    try {
      const parsed = switchSchema.safeParse(req.body);
      if (!parsed.success) {
        setFlash(req, 'error', 'invalid_input');
        res.redirect('/admin/database');
        return;
      }

      const target = toConnectionConfig(parsed.data);

      // 二次确认：必须手打目标库名
      if (parsed.data.confirmName !== targetName(target)) {
        setFlash(req, 'error', 'invalid_input', {});
        res.redirect('/admin/database');
        return;
      }

      const result = await dbSwitchService.switchTo(target, parsed.data.mode);
      console.info(`切库完成，复制行数：${JSON.stringify(result.copied)}`);

      // 会话已随切库清空，这里直接引导重新登录
      setFlash(req, 'success', 'admin.db.switched');
      res.redirect('/login');
    } catch (error) {
      if (!AppError.is(error)) {
        next(error);
        return;
      }
      setFlash(req, 'error', error.code);
      res.redirect('/admin/database');
    }
  })();
});
