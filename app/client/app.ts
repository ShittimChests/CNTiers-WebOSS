/**
 * 全局客户端入口。
 *
 * 架构是渐进增强，不是 hydration：服务端已经输出完整可用的 HTML，
 * 这里只为已存在的元素添加行为。任何一个增强器失效，页面依然可用。
 *
 * 元素通过 data-enhance="名字 名字" 声明需要哪些增强器，避免旧站那种
 * 「所有页面都执行所有 DOM 查询、靠 if (element) 判空区分页面」的写法。
 */
import { flash } from './enhancers/flash.js';
import { installFormHandlers } from './enhancers/forms.js';
import { menu } from './enhancers/menu.js';

type Enhancer = (element: HTMLElement) => void;

const REGISTRY: Record<string, Enhancer> = { menu, flash };

function enhanceAll(root: ParentNode = document): void {
  for (const element of root.querySelectorAll<HTMLElement>('[data-enhance]')) {
    const names = (element.dataset['enhance'] ?? '').split(/\s+/).filter(Boolean);
    for (const name of names) {
      const enhancer = REGISTRY[name];
      if (enhancer) enhancer(element);
      else console.warn(`未注册的增强器：${name}`);
    }
  }
}

function boot(): void {
  enhanceAll();
  installFormHandlers();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
