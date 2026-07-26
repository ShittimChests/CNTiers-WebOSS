import { describe, expect, it } from 'vitest';
import { rankEntries } from '../../app/utils/ranking.js';

/**
 * position 出现在公开 API 响应里，排序规则的任何偏移都是契约破坏。
 * 这里的样例即是锁定该契约的金样例。
 */
describe('rankEntries', () => {
  const positionsOf = (input: { points: number; player: string }[]) =>
    rankEntries(input).map((entry) => entry.position);

  it('按积分降序排列', () => {
    const ranked = rankEntries([
      { player: 'low', points: 10 },
      { player: 'high', points: 100 },
      { player: 'mid', points: 50 }
    ]);
    expect(ranked.map((entry) => entry.player)).toEqual(['high', 'mid', 'low']);
    expect(ranked.map((entry) => entry.position)).toEqual([1, 2, 3]);
  });

  it('同分共享名次，其后跳号（1,1,3,4,4,6）', () => {
    const positions = positionsOf([
      { player: 'a', points: 100 },
      { player: 'b', points: 100 },
      { player: 'c', points: 90 },
      { player: 'd', points: 80 },
      { player: 'e', points: 80 },
      { player: 'f', points: 70 }
    ]);
    expect(positions).toEqual([1, 1, 3, 4, 4, 6]);
  });

  it('全员同分时所有人都是第 1 名', () => {
    expect(
      positionsOf([
        { player: 'a', points: 5 },
        { player: 'b', points: 5 },
        { player: 'c', points: 5 }
      ])
    ).toEqual([1, 1, 1]);
  });

  it('同分时按玩家名稳定排序，与输入顺序无关', () => {
    const forward = rankEntries([
      { player: 'Zoe', points: 100 },
      { player: 'Adam', points: 100 }
    ]).map((entry) => entry.player);

    const reversed = rankEntries([
      { player: 'Adam', points: 100 },
      { player: 'Zoe', points: 100 }
    ]).map((entry) => entry.player);

    expect(forward).toEqual(reversed);
    expect(forward).toEqual(['Adam', 'Zoe']);
  });

  it('空输入返回空数组', () => {
    expect(rankEntries([])).toEqual([]);
  });

  it('不修改传入的数组与元素', () => {
    const input = [
      { player: 'a', points: 1 },
      { player: 'b', points: 2 }
    ];
    const snapshot = structuredClone(input);
    rankEntries(input);
    expect(input).toEqual(snapshot);
  });

  it('保留条目的其余字段', () => {
    const ranked = rankEntries([{ player: 'a', points: 1, id: 'entry-1', extra: true }]);
    expect(ranked[0]).toMatchObject({ id: 'entry-1', extra: true, position: 1 });
  });
});
