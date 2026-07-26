import type { ComponentChildren } from 'preact';
import type { ViewContext } from '../../../types/view.js';
import { resolveMessage } from '../../shared/messages.js';
import { assetUrl } from '../lib/assets.js';
import { Icon } from '../components/Icon.js';
import { Form } from '../components/Form.js';

interface BaseLayoutProps {
  /** 浏览器标签与 og:title 用；页面内的 h1 由页面自己写。 */
  title: string;
  ctx: ViewContext;
  description?: string;
  /** 额外的客户端入口（相对 app/ 的路径），如 'client/pages/board.ts'。 */
  scripts?: string[];
  children: ComponentChildren;
}

/**
 * 唯一的 HTML 骨架。
 *
 * 旧站把布局劈成 header.ejs / footer.ejs 两个文件：前者打开 <main>，
 * 后者关闭它，中间靠每个页面自觉夹在中间——没有真正的布局继承，
 * 也没法给单个页面加 meta 或页面级脚本。这里用组件组合解决这两点。
 */
export function BaseLayout({ title, ctx, description, scripts = [], children }: BaseLayoutProps) {
  return (
    <html lang="zh-CN">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#0F0C16" />
        {description && <meta name="description" content={description} />}
        <title>{title} · CNTiers</title>
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <link rel="stylesheet" href={assetUrl('styles/app.css')} />
        <script type="module" src={assetUrl('client/app.ts')} defer />
        {scripts.map((entry) => (
          <script key={entry} type="module" src={assetUrl(entry)} defer />
        ))}
      </head>
      <body>
        <a class="skip-link" href="#main">
          跳到主要内容
        </a>

        <SiteHeader ctx={ctx} />

        <main class="container" id="main">
          {ctx.flash && <FlashBanner ctx={ctx} />}
          {children}
        </main>

        <footer class="site-footer">
          <div class="container">
            <p>CNTiers · 中文 Minecraft 1.9+ PvP Subtier 榜单</p>
            <p>
              <a href="/api/docs">开放 API</a>
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}

/** flash 只经由 PRG + session 传递，不再用查询参数携带错误码。 */
function FlashBanner({ ctx }: { ctx: ViewContext }) {
  const flash = ctx.flash;
  if (!flash) return null;

  return (
    <div class={`flash flash--${flash.kind}`} data-enhance="flash">
      <p class="flash__text" role={flash.kind === 'error' ? 'alert' : 'status'}>
        {resolveMessage(flash.id, flash.params)}
      </p>
      <button class="flash__close" type="button" data-flash-close aria-label="关闭提示">
        <Icon name="close" />
      </button>
    </div>
  );
}

function SiteHeader({ ctx }: { ctx: ViewContext }) {
  const user = ctx.user;
  const isAdmin = user?.role === 'Admin' || user?.role === 'SuperAdmin';
  const isSuper = user?.role === 'SuperAdmin';

  return (
    <header class="site-header">
      <div class="container site-header__inner">
        {/* 品牌是链接而非 h1——h1 归页面标题，每页唯一 */}
        <a class="brand" href="/">
          <span class="brand__mark" aria-hidden="true">
            ◆
          </span>
          <span class="brand__name">CNTIERS</span>
        </a>

        <button
          class="nav-toggle"
          type="button"
          data-enhance="menu"
          data-menu-target="site-nav"
          aria-label="展开导航"
        >
          <Icon name="menu" />
        </button>

        <nav class="site-nav" id="site-nav" aria-label="主导航">
          <NavLink href="/" path={ctx.path}>
            榜单
          </NavLink>
          <NavLink href="/api/docs" path={ctx.path}>
            API
          </NavLink>

          {isAdmin && (
            <NavLink href="/admin" path={ctx.path}>
              后台
            </NavLink>
          )}
          {isSuper && (
            <NavLink href="/admin/settings" path={ctx.path}>
              设置
            </NavLink>
          )}

          {user ? (
            <span class="site-nav__account">
              <NavLink href="/account" path={ctx.path}>
                {user.username}
              </NavLink>
              <span class={`role-pill role-pill--${user.role.toLowerCase()}`}>{user.role}</span>
              <Form action="/logout" csrfToken={ctx.csrfToken} class="site-nav__logout">
                <button class="link-button" type="submit">
                  退出
                </button>
              </Form>
            </span>
          ) : (
            <span class="site-nav__account">
              <NavLink href="/login" path={ctx.path}>
                登录
              </NavLink>
              {ctx.settings.registrationEnabled && (
                <NavLink href="/register" path={ctx.path}>
                  注册
                </NavLink>
              )}
            </span>
          )}
        </nav>
      </div>
    </header>
  );
}

function NavLink({
  href,
  path,
  children
}: {
  href: string;
  path: string;
  children: ComponentChildren;
}) {
  const active = href === '/' ? path === '/' : path.startsWith(href);
  return (
    <a class="site-nav__link" href={href} aria-current={active ? 'page' : undefined}>
      {children}
    </a>
  );
}
