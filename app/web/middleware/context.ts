import type { NextFunction, Request, Response } from 'express';
import { settingsService } from '../../services/settingsService.js';
import type { ViewContext } from '../../types/view.js';
import type { Flash, MessageId, MessageParams } from '../shared/messages.js';
import { currentCsrfToken } from './csrf.js';

/**
 * 组装视图上下文，并挂到 res.locals 供路由取用。
 *
 * 与旧站的差别：上下文是一个类型化对象，显式作为 props 传进视图；
 * 旧站往 res.locals 上塞若干散字段，模板里时而写 `typeof x !== 'undefined'`
 * 时而不写，还得靠一个 fillErrorLocals 补丁函数兜底。
 */

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- 扩展 Express 的 Locals 需要
  namespace Express {
    interface Locals {
      ctx: ViewContext;
    }
  }
}

export async function attachContext(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const settings = await settingsService.get();
    const microsoftReady = await settingsService.isMicrosoftEnabled();

    res.locals.ctx = {
      user: req.session.user ?? null,
      /**
       * 惰性铸造：只有视图真的渲染 POST 表单、读到这个属性时才写会话。
       * 若在这里直接求值，任何一次匿名 GET（含 404）都会落一行 sessions
       * 并下发 Set-Cookie —— 首页与 /api/docs 是被机器人反复命中的公开页。
       */
      get csrfToken(): string {
        return currentCsrfToken(req);
      },
      // 读一次即清空：这是 flash 的定义
      flash: takeFlash(req),
      settings: {
        registrationEnabled: settings.registrationEnabled,
        microsoftReady
      },
      path: req.path
    };
    next();
  } catch (error) {
    next(error);
  }
}

function takeFlash(req: Request): Flash | null {
  const flash = req.session.flash;
  if (!flash) return null;
  delete req.session.flash;
  return flash;
}

/** 设置一条跨重定向的提示。配合 PRG 使用。 */
export function setFlash(
  req: Request,
  kind: Flash['kind'],
  id: MessageId,
  params?: MessageParams
): void {
  req.session.flash = params ? { kind, id, params } : { kind, id };
}

/** 视图上下文的取用入口，避免各处直接摸 res.locals。 */
export function viewContext(res: Response): ViewContext {
  return res.locals.ctx;
}
