/**
 * flash 横幅的关闭按钮。
 *
 * 标记约定：<div data-enhance="flash"> 内含 <button data-flash-close>
 * 无 JS 时横幅照常显示，只是不能手动关闭——这是可接受的降级。
 */
export function flash(banner: HTMLElement): void {
  const closeButton = banner.querySelector<HTMLButtonElement>('[data-flash-close]');
  if (!closeButton) return;

  closeButton.addEventListener('click', () => {
    banner.remove();
  });
}
