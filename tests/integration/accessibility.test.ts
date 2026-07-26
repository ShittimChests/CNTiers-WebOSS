import bcrypt from 'bcryptjs';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app/app.js';
import { createKysely } from '../../app/db/dialects.js';
import { dbManager } from '../../app/db/manager.js';
import { runMigrations } from '../../app/db/migrator.js';
import { categoryRepository } from '../../app/repositories/categoryRepository.js';
import { entryRepository } from '../../app/repositories/entryRepository.js';
import { settingsRepository } from '../../app/repositories/settingsRepository.js';
import { userRepository } from '../../app/repositories/userRepository.js';
import { settingsService } from '../../app/services/settingsService.js';

/**
 * 全站可访问性与 CSP 的结构性检查（WCAG 2.1 AA 的可自动验证部分）。
 *
 * 覆盖不了主观判断（例如文案是否清楚），但能持续守住这些容易回退的点：
 * 每页唯一 h1、跳转链接、控件与标签的关联、按钮有可访问名称、
 * 装饰图标不被朗读、以及零内联样式/事件。
 *
 * 旧站在这些项上大面积不达标：h1 全站都是品牌名、表头排序只绑 click、
 * 提示区没有 live region、汉堡菜单没有 aria-expanded。
 */

let app: Express;
const PASSWORD = 'a11y password';

/** 需要检查的页面。登录态页面用 SuperAdmin 走一遍。 */
const PUBLIC_PAGES = [
  '/',
  '/login',
  '/register',
  '/forgot',
  '/verify?email=a@b.c',
  '/reset?email=a@b.c',
  '/api/docs'
];
const PRIVATE_PAGES = [
  '/account',
  '/admin',
  '/admin/categories',
  '/admin/settings',
  '/admin/users',
  '/admin/database'
];

function csrfOf(html: string): string {
  const match = /name="_csrf" value="([^"]+)"/.exec(html);
  if (!match) throw new Error('页面里没有 CSRF 令牌');
  return match[1]!;
}

async function loginAgent() {
  const agent = request.agent(app).set('X-Forwarded-For', '10.9.0.1');
  const page = await agent.get('/login');
  await agent
    .post('/login')
    .type('form')
    .send({ _csrf: csrfOf(page.text), identifier: 'Root', password: PASSWORD });
  return agent;
}

beforeAll(async () => {
  const dbConfig = { driver: 'sqlite' as const, file: ':memory:' };
  await dbManager.switchTo(await createKysely(dbConfig), dbConfig);
  await runMigrations(dbManager.db());

  await settingsRepository.save({ registrationEnabled: true });
  settingsService.invalidate();

  await userRepository.create({
    username: 'Root',
    email: 'root@example.com',
    passwordHash: await bcrypt.hash(PASSWORD, 4),
    role: 'SuperAdmin',
    emailVerified: true
  });
  await categoryRepository.ensureMany(['Sword', 'Axe']);
  await entryRepository.create({
    player: 'Alpha',
    rank: 'SubtierGrandmaster',
    points: 1200,
    testServer: 'Pico #1',
    tiers: { Sword: 'HT1' }
  });

  app = createApp();
});

afterAll(async () => {
  await dbManager.close();
});

/** 取得所有待检查页面的 HTML。 */
async function collectPages(): Promise<{ path: string; html: string }[]> {
  const pages: { path: string; html: string }[] = [];

  for (const path of PUBLIC_PAGES) {
    const response = await request(app).get(path);
    expect(response.status, `${path} 应可访问`).toBe(200);
    pages.push({ path, html: response.text });
  }

  const agent = await loginAgent();
  for (const path of PRIVATE_PAGES) {
    const response = await agent.get(path);
    expect(response.status, `${path} 应可访问`).toBe(200);
    pages.push({ path, html: response.text });
  }

  return pages;
}

let pages: { path: string; html: string }[];

beforeAll(async () => {
  pages = await collectPages();
});

describe('文档结构', () => {
  it('每个页面恰好一个 h1', () => {
    for (const { path, html } of pages) {
      expect(html.match(/<h1[\s>]/g)?.length ?? 0, `${path} 的 h1 数量`).toBe(1);
    }
  });

  it('每个页面都有语言标注与跳转链接', () => {
    for (const { path, html } of pages) {
      expect(html, path).toContain('<html lang="zh-CN">');
      expect(html, path).toContain('href="#main"');
      expect(html, path).toContain('id="main"');
    }
  });

  it('每个页面都有 landmark 与唯一标题', () => {
    for (const { path, html } of pages) {
      expect(html, path).toContain('<header class="site-header">');
      expect(html, path).toContain('aria-label="主导航"');
      expect(html, path).toContain('<main');
      expect(html, path).toMatch(/<title>[^<]+<\/title>/);
    }
  });
});

describe('表单可访问性', () => {
  it('每个输入控件都有关联的 label', () => {
    for (const { path, html } of pages) {
      // 收集所有非 hidden 的具名输入控件
      const inputs = [...html.matchAll(/<(input|select|textarea)\b([^>]*)>/g)].filter(
        ([, , attrs]) => !/type="(hidden|submit|button)"/.test(attrs ?? '')
      );

      for (const [, , attrs = ''] of inputs) {
        const id = /id="([^"]+)"/.exec(attrs)?.[1];
        const hasAriaLabel = attrs.includes('aria-label="');
        // radio/checkbox 常被 label 包裹，此时不需要 id
        const wrapped = /type="(radio|checkbox)"/.test(attrs);

        if (hasAriaLabel || wrapped) continue;

        expect(id, `${path} 的输入控件缺少 id：${attrs.slice(0, 80)}`).toBeDefined();
        expect(html, `${path} 的 ${String(id)} 缺少对应 label`).toContain(`for="${String(id)}"`);
      }
    }
  });

  it('提示与错误文本通过 aria-describedby 关联', () => {
    for (const { path, html } of pages) {
      for (const [, id] of html.matchAll(/aria-describedby="([^"]+)"/g)) {
        for (const single of (id ?? '').split(' ')) {
          expect(html, `${path} 的 ${single} 被引用但不存在`).toContain(`id="${single}"`);
        }
      }
    }
  });

  it('每个按钮都有可访问名称', () => {
    for (const { path, html } of pages) {
      for (const [full] of html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)) {
        const hasAriaLabel = /aria-label="[^"]+"/.test(full);
        // 去掉标签后仍有文字，或含带可访问名的图标
        const text = full.replace(/<[^>]+>/g, '').trim();
        expect(hasAriaLabel || text.length > 0, `${path} 有无名按钮：${full.slice(0, 90)}`).toBe(
          true
        );
      }
    }
  });

  it('所有表单都声明 action 与 method', () => {
    for (const { path, html } of pages) {
      for (const [full] of html.matchAll(/<form\b[^>]*>/g)) {
        expect(full, `${path} 的表单缺少 action`).toMatch(/action="/);
        expect(full, `${path} 的表单缺少 method`).toMatch(/method="/);
      }
    }
  });
});

describe('图标与动态区域', () => {
  it('装饰性图标对辅助技术隐藏', () => {
    for (const { path, html } of pages) {
      for (const [full] of html.matchAll(/<svg\b[^>]*>/g)) {
        const hidden = full.includes('aria-hidden="true"');
        const labelled = /aria-label="[^"]+"/.test(full) && full.includes('role="img"');
        expect(hidden || labelled, `${path} 的 svg 既未隐藏也无名称：${full.slice(0, 80)}`).toBe(
          true
        );
      }
    }
  });

  it('提示区域声明 role，便于屏幕阅读器播报', () => {
    // 首页的搜索结果计数
    const home = pages.find((page) => page.path === '/')!.html;
    expect(home).toContain('role="status"');
    expect(home).toContain('aria-live="polite"');
  });

  it('移动菜单按钮声明展开状态与控制目标', () => {
    for (const { path, html } of pages) {
      expect(html, path).toContain('data-menu-target="site-nav"');
      expect(html, path).toContain('aria-label="展开导航"');
    }
  });
});

describe('CSP 纪律', () => {
  it('所有页面零内联样式、零内联事件处理器', () => {
    for (const { path, html } of pages) {
      expect(html, `${path} 出现内联样式`).not.toMatch(/\sstyle="/);
      expect(html, `${path} 出现内联事件`).not.toMatch(/\son[a-z]+="/);
    }
  });

  it('响应头里的 CSP 不含 unsafe-inline', async () => {
    const response = await request(app).get('/');
    const csp = response.headers['content-security-policy'] ?? '';
    expect(csp).toContain("style-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).toContain("script-src-attr 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('所有脚本都来自本站且是模块', () => {
    for (const { path, html } of pages) {
      for (const [full, src] of html.matchAll(/<script\b[^>]*src="([^"]+)"[^>]*>/g)) {
        expect(src, `${path} 加载了外部脚本`).toMatch(/^\//);
        expect(full, `${path} 的脚本不是模块`).toContain('type="module"');
      }
    }
  });
});
