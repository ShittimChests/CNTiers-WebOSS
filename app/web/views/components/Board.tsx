import type { RankedEntry } from '../../../types/domain.js';
import { Chip, RankMedal, TestServerTag, TierBadge, XpBar } from './ui.js';

interface BoardProps {
  entries: RankedEntry[];
  /** 用于积分槽的比例基准，通常是全榜最高分。 */
  maxPoints: number;
}

/**
 * 榜单列表。桌面与移动共用这一份标记，布局差异全部由 CSS 的
 * grid 区域完成——不再需要旧站那样为移动端补一套 data-label。
 */
export function Board({ entries, maxPoints }: BoardProps) {
  return (
    <>
      <div class="board__labels" aria-hidden="true">
        <span>名次</span>
        <span>玩家</span>
        <span>段位</span>
        <span>积分</span>
        <span>细分项目</span>
      </div>

      <ol class="board">
        {entries.map((entry) => (
          <BoardRow key={entry.id} entry={entry} maxPoints={maxPoints} />
        ))}
      </ol>
    </>
  );
}

function BoardRow({ entry, maxPoints }: { entry: RankedEntry; maxPoints: number }) {
  const topClass =
    entry.position <= 3 ? ` board__row--top${String(entry.position)}` : '';

  const tiers = Object.entries(entry.tiers).sort(([a], [b]) => a.localeCompare(b));

  return (
    <li
      class={`board__row${topClass}`}
      data-player={entry.player}
      data-points={entry.points}
      data-position={entry.position}
      data-rank={entry.rank}
      // 客户端搜索按这个字段过滤，服务端预先拼好省得每次在浏览器里算
      data-search={buildSearchIndex(entry)}
    >
      <span class="board__rank">
        <RankMedal position={entry.position} />#{entry.position}
      </span>

      <span class="board__player">
        {entry.player}
        {entry.testServer && <TestServerTag name={entry.testServer} />}
      </span>

      <span class="board__tier">
        <TierBadge rank={entry.rank} />
      </span>

      <span class="board__points">
        {entry.points}
        <XpBar value={entry.points} max={maxPoints} />
      </span>

      <span class="board__cats">
        {tiers.map(([name, tier]) => (
          <Chip key={name} label={name} tier={tier} />
        ))}
      </span>
    </li>
  );
}

function buildSearchIndex(entry: RankedEntry): string {
  return [entry.player, entry.rank, entry.testServer ?? '', ...Object.entries(entry.tiers).flat()]
    .join(' ')
    .toLowerCase();
}
