/**
 * 竞技排名：按积分降序，同分共享名次，其后跳号（1, 1, 3, 4, 4, 6 …）。
 *
 * 逐行移植自旧实现（src/services/dataStore.js 的 rankEntries），包括同分时用
 * localeCompare 做稳定排序这一点 —— position 会出现在公开 API 响应里，
 * 排序规则的任何偏移都是契约破坏，因此这里刻意不"改进"比较方式。
 *
 * 与旧实现的唯一区别是调用时机：position 不再落库，而是每次读取时计算。
 */
export function rankEntries<T extends { points: number; player: string }>(
  entries: readonly T[]
): (T & { position: number })[] {
  const sorted = [...entries].sort((a, b) => {
    const diff = b.points - a.points;
    if (diff !== 0) return diff;
    return a.player.localeCompare(b.player);
  });

  const ranked: (T & { position: number })[] = new Array<T & { position: number }>(sorted.length);

  for (let i = 0; i < sorted.length;) {
    let j = i;
    // 同分区间共享区间起点的名次
    while (j < sorted.length && sorted[j]!.points === sorted[i]!.points) {
      ranked[j] = { ...sorted[j]!, position: i + 1 };
      j += 1;
    }
    i = j;
  }

  return ranked;
}
