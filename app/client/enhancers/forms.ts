/**
 * 表单的两项全局增强，都用事件委托挂在 document 上：
 *
 *   1. data-confirm —— 破坏性操作的二次确认。这个模式是从旧站保留下来的
 *      唯一实现：CSP 禁止内联 onsubmit，所以确认逻辑必须由脚本接管。
 *   2. 防重复提交 —— 提交后禁用按钮并显示等待文案。旧站只对登录按钮做了，
 *      这里推广到所有表单（后台的删除/更新同样会被手快点两次）。
 *
 * 两者都不阻止无 JS 环境下的正常提交。
 */

function markSubmitting(form: HTMLFormElement): void {
  const button = form.querySelector<HTMLButtonElement>('button[type="submit"], button:not([type])');
  if (!button || button.disabled) return;

  const pendingLabel = button.dataset['pendingLabel'];
  if (pendingLabel) button.textContent = pendingLabel;

  // 同步禁用会取消提交，推到下一个任务
  window.setTimeout(() => {
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
  }, 0);
}

export function installFormHandlers(): void {
  document.addEventListener(
    'submit',
    (event: SubmitEvent) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement)) return;

      const question = form.dataset['confirm'];
      if (question && !window.confirm(question)) {
        event.preventDefault();
        return;
      }

      markSubmitting(form);
    },
    // 捕获阶段，确保在浏览器默认提交前先跑
    true
  );
}
