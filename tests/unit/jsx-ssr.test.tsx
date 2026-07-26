import { render } from 'preact-render-to-string';
import { describe, expect, it } from 'vitest';

/**
 * 视图层的地基检查：JSX 能否编译、SSR 能否输出、转义是否默认开启。
 *
 * 最后一条是选用 JSX-SSR 的主要理由之一——旧站靠 `<%=` 与 `<%-` 一字之差
 * 区分转义与不转义，这里转义是语言默认行为，绕过它需要显式写
 * dangerouslySetInnerHTML（已被 ESLint 禁止）。
 */
describe('JSX SSR', () => {
  it('渲染基本标记', () => {
    expect(render(<p class="hint">榜单总览</p>)).toBe('<p class="hint">榜单总览</p>');
  });

  it('默认转义文本内容，插入的 HTML 不会被执行', () => {
    const hostile = '<script>alert(1)</script>';
    const html = render(<span>{hostile}</span>);
    // 只要 `<` 被转义，标签就无法形成；`>` 在文本节点中无害，规范也不要求转义
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script');
  });

  it('默认转义属性值中的引号', () => {
    const html = render(<a href={'/x?a="b"'}>链接</a>);
    expect(html).toContain('&quot;');
  });

  it('支持组件组合与 children 传递', () => {
    function Card({ title, children }: { title: string; children?: preact.ComponentChildren }) {
      return (
        <section class="card">
          <h2>{title}</h2>
          {children}
        </section>
      );
    }
    const html = render(
      <Card title="设置">
        <p>内容</p>
      </Card>
    );
    expect(html).toBe('<section class="card"><h2>设置</h2><p>内容</p></section>');
  });
});
