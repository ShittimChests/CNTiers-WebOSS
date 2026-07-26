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
  res.send(`<!DOCTYPE html>${html}`);
}
