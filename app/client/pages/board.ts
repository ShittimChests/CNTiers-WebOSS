/**
 * 榜单页的客户端增强。
 *
 * 两件事，都建立在服务端已经渲染好完整榜单的前提上：
 *   1. 搜索即时过滤（服务端的 ?q= 仍然可用，无脚本时就走它）
 *   2. 排序就地重排（服务端的 ?sort= 仍然可用）
 *
 * 排序的比较键直接取行上的 data-* 属性——服务端已经把值放好，
 * 这里不重新实现一份业务排序逻辑。
 */

const DEBOUNCE_MS = 200;

function debounce<T extends (...args: never[]) => void>(fn: T, wait: number): T {
  let timer: number | undefined;
  return ((...args: never[]) => {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), wait);
  }) as T;
}

function setupSearch(): void {
  const input = document.querySelector<HTMLInputElement>('#board-search');
  const board = document.querySelector<HTMLOListElement>('.board');
  const status = document.querySelector<HTMLElement>('#board-status');
  if (!input || !board) return;

  const form = input.closest('form');
  const rows = Array.from(board.querySelectorAll<HTMLLIElement>('.board__row'));

  const apply = (): void => {
    const needle = input.value.trim().toLowerCase();
    let visible = 0;

    for (const row of rows) {
      const haystack = row.dataset['search'] ?? '';
      const match = needle === '' || haystack.includes(needle);
      row.hidden = !match;
      if (match) visible += 1;
    }

    if (status) {
      status.textContent =
        needle === '' ? `共 ${String(visible)} 条` : `找到 ${String(visible)} 条结果`;
    }
  };

  // 接管提交，避免整页刷新（服务端过滤依然是无脚本时的后备）
  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    apply();
  });

  input.addEventListener('input', debounce(apply, DEBOUNCE_MS));

  // Ctrl/Cmd + K 聚焦搜索
  document.addEventListener('keydown', (event: KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      input.focus();
      input.select();
    }
  });
}

type SortKey = 'position' | 'player' | 'points' | 'rank';

function readKey(row: HTMLElement, key: SortKey): string | number {
  const raw = row.dataset[key] ?? '';
  return key === 'points' || key === 'position' ? Number(raw) : raw;
}

function setupSort(): void {
  const bar = document.querySelector<HTMLElement>('.sortbar');
  const board = document.querySelector<HTMLOListElement>('.board');
  if (!bar || !board) return;

  bar.addEventListener('click', (event: MouseEvent) => {
    const link = (event.target as HTMLElement | null)?.closest<HTMLAnchorElement>('.sortbar__link');
    if (!link) return;

    const key = link.dataset['sort'] as SortKey | undefined;
    const dir = link.dataset['dir'] === 'desc' ? -1 : 1;
    if (!key) return;

    event.preventDefault();

    const rows = Array.from(board.querySelectorAll<HTMLLIElement>('.board__row'));
    rows.sort((a, b) => {
      const left = readKey(a, key);
      const right = readKey(b, key);
      if (typeof left === 'number' && typeof right === 'number') return (left - right) * dir;
      return String(left).localeCompare(String(right)) * dir;
    });

    // 一次性 append，避免逐行操作触发多次重排
    const fragment = document.createDocumentFragment();
    for (const row of rows) fragment.append(row);
    board.append(fragment);

    // 让地址栏与当前视图一致，刷新后结果不变
    const url = new URL(link.href, window.location.origin);
    window.history.replaceState(null, '', url.search);

    // 更新当前项标记与下一次点击的方向
    for (const other of bar.querySelectorAll<HTMLAnchorElement>('.sortbar__link')) {
      other.removeAttribute('aria-current');
    }
    link.setAttribute('aria-current', 'true');
    link.dataset['dir'] = dir === 1 ? 'desc' : 'asc';
  });
}

setupSearch();
setupSort();
