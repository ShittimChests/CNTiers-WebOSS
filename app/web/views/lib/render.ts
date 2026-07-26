import type { Response } from 'express';
import type { VNode } from 'preact';
import { render as renderToString } from 'preact-render-to-string';

/**
 * 把 JSX 渲染成完整 HTML 文档并发送。
 *
 * 选 JSX-SSR 而不是字符串模板，是为了让视图进入类型系统：页面 props 是
 * interface，路由改字段名会在编译期报错。这里没有 hydration——客户端加载的
 * 是独立的渐进增强脚本，Preact 只在服务端当"类型安全的 HTML 函数"用。
 */
export function renderPage(res: Response, node: VNode, status = 200): void {
  const html = renderToString(node);
  res.status(status);
  res.type('html');
  /*
   * 所有 SSR 页面都默认不可缓存。
   *
   * 每个页面都可能带用户态（导航栏的账号、flash、CSRF 隐藏域），而站点跑在
   * Cloudflare 后面。以前不设这个头是靠「每个响应都带 Set-Cookie」被动阻止了
   * 共享缓存；CSRF 令牌改成惰性铸造之后那道副作用没了，必须把意图写明。
   * 真要让某个纯公开页可被共享缓存，应当在那个路由上显式覆盖。
   */
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(`<!DOCTYPE html>${html}`);
}
