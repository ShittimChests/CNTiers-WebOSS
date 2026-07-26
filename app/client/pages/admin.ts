/**
 * 后台条目列表的客户端筛选。
 *
 * 只在当前页的条目里过滤（后台是服务端分页的），因此不涉及请求。
 * 索引由服务端预先拼进 data-filter，浏览器不必每次现算。
 */
const input = document.querySelector<HTMLInputElement>('#admin-filter');
const list = document.querySelector<HTMLUListElement>('.entry-list');

if (input && list) {
  const cards = Array.from(list.querySelectorAll<HTMLLIElement>('.entry'));

  input.addEventListener('input', () => {
    const needle = input.value.trim().toLowerCase();
    for (const card of cards) {
      const haystack = card.dataset['filter'] ?? '';
      card.hidden = needle !== '' && !haystack.includes(needle);
    }
  });
}
