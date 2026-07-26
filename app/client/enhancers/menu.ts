/**
 * 移动端导航开关。
 *
 * 旧实现只 toggle 一个 class，不更新任何 ARIA 状态，也不处理 Esc 与焦点，
 * 屏幕阅读器与键盘用户完全感知不到菜单的开合。
 *
 * 标记约定：
 *   <button data-enhance="menu" data-menu-target="siteNav" aria-expanded="false">
 */
export function menu(button: HTMLElement): void {
  if (!(button instanceof HTMLButtonElement)) return;

  const targetId = button.dataset['menuTarget'];
  const nav = targetId ? document.getElementById(targetId) : null;
  if (!nav) return;

  button.setAttribute('aria-controls', nav.id);
  button.setAttribute('aria-expanded', 'false');

  const setOpen = (open: boolean): void => {
    button.setAttribute('aria-expanded', String(open));
    nav.classList.toggle('is-open', open);
  };

  button.addEventListener('click', () => {
    const open = button.getAttribute('aria-expanded') !== 'true';
    setOpen(open);
    if (open) {
      // 打开后把焦点交给菜单内第一个可聚焦项
      nav.querySelector<HTMLElement>('a, button')?.focus();
    }
  });

  nav.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    setOpen(false);
    button.focus();
  });

  // 点击菜单外部关闭
  document.addEventListener('click', (event: MouseEvent) => {
    if (button.getAttribute('aria-expanded') !== 'true') return;
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (nav.contains(target) || button.contains(target)) return;
    setOpen(false);
  });
}
