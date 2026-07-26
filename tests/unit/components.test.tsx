import { render } from 'preact-render-to-string';
import { describe, expect, it } from 'vitest';
import type { RankedEntry } from '../../app/types/domain.js';
import type { ViewContext } from '../../app/types/view.js';
import { resolveMessage } from '../../app/web/shared/messages.js';
import { materialForRank } from '../../app/web/shared/tiers.js';
import { Board } from '../../app/web/views/components/Board.js';
import { Checkbox, Field, Form } from '../../app/web/views/components/Form.js';
import { TierBadge, XpBar } from '../../app/web/views/components/ui.js';
import { BaseLayout } from '../../app/web/views/layouts/BaseLayout.js';

const ctx: ViewContext = {
  user: null,
  csrfToken: 'token-abc123',
  flash: null,
  settings: { registrationEnabled: true, microsoftReady: false },
  path: '/'
};

function entry(overrides: Partial<RankedEntry> = {}): RankedEntry {
  return {
    id: 'e1',
    player: 'Alice',
    rank: 'SubtierMaster',
    points: 900,
    testServer: null,
    tiers: {},
    position: 1,
    createdAt: '',
    updatedAt: '',
    ...overrides
  };
}

describe('Form', () => {
  it('POST 表单自动注入 CSRF 隐藏域', () => {
    const html = render(
      <Form action="/x" csrfToken="token-abc123">
        <button type="submit">保存</button>
      </Form>
    );
    // 旧站的 22 个表单各自手抄这一行，漏写就是运行时 403
    expect(html).toContain('<input type="hidden" name="_csrf" value="token-abc123"');
  });

  it('GET 表单不注入 CSRF（不需要）', () => {
    const html = render(
      <Form action="/search" method="get">
        <input name="q" />
      </Form>
    );
    expect(html).not.toContain('_csrf');
  });

  it('confirm 属性输出 data-confirm，交给增强器接管', () => {
    const html = render(
      <Form action="/x" csrfToken="t" confirm="确认删除？">
        <button type="submit">删除</button>
      </Form>
    );
    expect(html).toContain('data-confirm="确认删除？"');
  });
});

describe('Field', () => {
  it('label 与输入框通过 for/id 关联', () => {
    const html = render(<Field name="player" label="玩家名" />);
    expect(html).toContain('for="f-player"');
    expect(html).toContain('id="f-player"');
  });

  it('hint 自动挂到 aria-describedby', () => {
    const html = render(<Field name="player" label="玩家名" hint="1–32 个字符" />);
    expect(html).toContain('aria-describedby="f-player-hint"');
    expect(html).toContain('id="f-player-hint"');
  });

  it('error 同时标记 aria-invalid 并纳入 describedby', () => {
    const html = render(<Field name="player" label="玩家名" hint="提示" error="不合法" />);
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('aria-describedby="f-player-hint f-player-error"');
  });

  it('没有 hint 与 error 时不输出空的 describedby', () => {
    const html = render(<Field name="player" label="玩家名" />);
    expect(html).not.toContain('aria-describedby');
  });

  it('复选框也连线 label 与 hint', () => {
    const html = render(<Checkbox name="reg" label="开放注册" checked hint="关闭后返回 404" />);
    expect(html).toContain('for="f-reg"');
    expect(html).toContain('aria-describedby="f-reg-hint"');
    expect(html).toContain('checked');
  });
});

describe('materialForRank', () => {
  it('映射七档已知段位', () => {
    expect(materialForRank('SubtierRookie')).toBe('stone');
    expect(materialForRank('SubtierNovice')).toBe('iron');
    expect(materialForRank('SubtierCadet')).toBe('copper');
    expect(materialForRank('SubtierSpecialist')).toBe('gold');
    expect(materialForRank('SubtierAce')).toBe('diamond');
    expect(materialForRank('SubtierMaster')).toBe('emerald');
    expect(materialForRank('SubtierGrandmaster')).toBe('netherite');
  });

  it('匹配宽容：忽略大小写、空格与 Subtier 前缀', () => {
    expect(materialForRank('master')).toBe('emerald');
    expect(materialForRank('  Subtier Master ')).toBe('emerald');
    expect(materialForRank('GRANDMASTER')).toBe('netherite');
  });

  it('认不出的段位退回石质档，不报错', () => {
    // 段位在后台是自由文本，打错字不该让徽章消失
    expect(materialForRank('打错的段位')).toBe('stone');
    expect(materialForRank('')).toBe('stone');
  });

  it('徽章渲染出材质 class，且文字始终可见', () => {
    const html = render(<TierBadge rank="SubtierGrandmaster" />);
    expect(html).toContain('badge--netherite');
    expect(html).toContain('SubtierGrandmaster');
  });
});

describe('XpBar', () => {
  it('数值走属性而非内联样式（CSP 不放开 style-src）', () => {
    const html = render(<XpBar value={900} max={1200} />);
    expect(html).toContain('value="900"');
    expect(html).toContain('max="1200"');
    expect(html).not.toContain('style=');
  });

  it('旁边有可见数字，因此对辅助技术隐藏', () => {
    expect(render(<XpBar value={1} max={2} />)).toContain('aria-hidden="true"');
  });

  it('max 为 0 时不产生非法属性', () => {
    const html = render(<XpBar value={0} max={0} />);
    expect(html).toContain('max="1"');
  });
});

describe('Board', () => {
  it('前三名各带一个材质描边 class', () => {
    const html = render(
      <Board
        entries={[
          entry({ id: '1', position: 1 }),
          entry({ id: '2', position: 2, player: 'B' }),
          entry({ id: '3', position: 3, player: 'C' }),
          entry({ id: '4', position: 4, player: 'D' })
        ]}
        maxPoints={900}
      />
    );
    expect(html).toContain('board__row--top1');
    expect(html).toContain('board__row--top2');
    expect(html).toContain('board__row--top3');
    expect(html).not.toContain('board__row--top4');
  });

  it('细分项目按名字排序输出', () => {
    const html = render(
      <Board entries={[entry({ tiers: { Sword: 'HT1', Axe: 'LT2' } })]} maxPoints={900} />
    );
    expect(html.indexOf('Axe')).toBeLessThan(html.indexOf('Sword'));
  });

  it('测试服存在时渲染标记，不存在时不渲染', () => {
    expect(render(<Board entries={[entry({ testServer: 'Pico #3' })]} maxPoints={1} />)).toContain(
      'Pico #3'
    );
    expect(render(<Board entries={[entry()]} maxPoints={1} />)).not.toContain('class="tag"');
  });

  it('服务端预拼搜索索引，省得浏览器每次现算', () => {
    const html = render(
      <Board entries={[entry({ tiers: { Sword: 'HT1' }, testServer: 'Pico' })]} maxPoints={1} />
    );
    expect(html).toContain('data-search="alice subtiermaster pico sword ht1"');
  });

  it('列标签行对辅助技术隐藏（每行内已有结构）', () => {
    const html = render(<Board entries={[entry()]} maxPoints={1} />);
    expect(html).toContain('<div class="board__labels" aria-hidden="true">');
  });
});

describe('BaseLayout', () => {
  it('输出语言、skip link 与主内容锚点', () => {
    const html = render(
      <BaseLayout title="测试" ctx={ctx}>
        <p>内容</p>
      </BaseLayout>
    );
    expect(html).toContain('<html lang="zh-CN">');
    expect(html).toContain('href="#main"');
    expect(html).toContain('id="main"');
    expect(html).toContain('<title>测试 · CN Subtiers</title>');
  });

  it('品牌是链接而非 h1——h1 留给页面标题', () => {
    const html = render(
      <BaseLayout title="测试" ctx={ctx}>
        <h1>页面标题</h1>
      </BaseLayout>
    );
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain('class="brand"');
  });

  it('未登录时显示登录与注册（注册受设置开关控制）', () => {
    const open = render(
      <BaseLayout title="t" ctx={ctx}>
        <p />
      </BaseLayout>
    );
    expect(open).toContain('href="/register"');

    const closed = render(
      <BaseLayout
        title="t"
        ctx={{ ...ctx, settings: { registrationEnabled: false, microsoftReady: false } }}
      >
        <p />
      </BaseLayout>
    );
    expect(closed).not.toContain('href="/register"');
  });

  it('管理员看到后台入口，超级管理员额外看到设置', () => {
    const admin = render(
      <BaseLayout
        title="t"
        ctx={{ ...ctx, user: { id: 'u', username: 'A', email: 'a@b.c', role: 'Admin' } }}
      >
        <p />
      </BaseLayout>
    );
    expect(admin).toContain('href="/admin"');
    expect(admin).not.toContain('href="/admin/settings"');

    const superAdmin = render(
      <BaseLayout
        title="t"
        ctx={{ ...ctx, user: { id: 'u', username: 'S', email: 's@b.c', role: 'SuperAdmin' } }}
      >
        <p />
      </BaseLayout>
    );
    expect(superAdmin).toContain('href="/admin/settings"');
    expect(superAdmin).toContain('role-pill--superadmin');
  });

  it('登录后的退出按钮走 POST 并带 CSRF', () => {
    const html = render(
      <BaseLayout
        title="t"
        ctx={{ ...ctx, user: { id: 'u', username: 'A', email: 'a@b.c', role: 'User' } }}
      >
        <p />
      </BaseLayout>
    );
    expect(html).toContain('action="/logout" method="post"');
    expect(html).toContain('value="token-abc123"');
  });

  it('当前导航项标记 aria-current', () => {
    const html = render(
      <BaseLayout title="t" ctx={{ ...ctx, path: '/api/docs' }}>
        <p />
      </BaseLayout>
    );
    expect(html).toContain('href="/api/docs" aria-current="page"');
  });

  it('flash 渲染成 alert 或 status，并可关闭', () => {
    const error = render(
      <BaseLayout title="t" ctx={{ ...ctx, flash: { kind: 'error', id: 'code_invalid' } }}>
        <p />
      </BaseLayout>
    );
    expect(error).toContain('role="alert"');
    expect(error).toContain('验证码不正确');
    expect(error).toContain('data-flash-close');

    const success = render(
      <BaseLayout title="t" ctx={{ ...ctx, flash: { kind: 'success', id: 'auth.verified' } }}>
        <p />
      </BaseLayout>
    );
    expect(success).toContain('role="status"');
    expect(success).toContain('邮箱验证成功');
  });
});

describe('resolveMessage', () => {
  it('同时接受错误码与文案键', () => {
    expect(resolveMessage('category_exists')).toBe('该细分项目已存在');
    expect(resolveMessage('admin.entry.created')).toBe('条目已添加');
  });

  it('填充占位符', () => {
    // 文案里带 {n} 时由 params 提供实参
    expect(resolveMessage('not_found', { unused: 1 })).toBe('找不到请求的资源');
  });

  it('未知键返回兜底文案而不是崩掉', () => {
    expect(resolveMessage('nope' as never)).toBe('操作已完成');
  });
});
