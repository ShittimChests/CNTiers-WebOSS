import type { Flash } from '../web/shared/messages.js';
import type { PublicUser } from './domain.js';

/**
 * 每个页面都能拿到的公共上下文。由 locals 中间件组装，
 * 通过 props 显式传给视图——不再依赖 res.locals 那种「有时有有时没有」的隐式契约
 * （旧站为此还专门写了个 fillErrorLocals 补丁函数）。
 */
export interface ViewContext {
  user: PublicUser | null;
  /**
   * 必须是 readonly：实现是一个只有 getter 的惰性属性（见 middleware/context.ts），
   * 声明成可写的话 `ctx.csrfToken = x` 会在运行时抛 TypeError 而 tsc 不报错
   * ——而「就地改 ctx」在本仓库是既有写法（requireAuth 就在改 ctx.user）。
   */
  readonly csrfToken: string;
  flash: Flash | null;
  /** 影响导航与登录页按钮显隐的公开设置。 */
  settings: {
    registrationEnabled: boolean;
    microsoftReady: boolean;
  };
  /** 当前路径，用于给导航项加 aria-current。 */
  path: string;
}

/** 所有页面 ViewModel 的公共部分。 */
export interface PageProps {
  ctx: ViewContext;
}
