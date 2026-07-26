import type { SortDirection, SortKey } from '../../../services/leaderboardService.js';
import type { RankedEntry } from '../../../types/domain.js';
import type { PageProps } from '../../../types/view.js';
import { Board } from '../components/Board.js';
import { Form } from '../components/Form.js';
import { Icon } from '../components/Icon.js';
import { SortBar } from '../components/SortBar.js';
import { EmptyState } from '../components/ui.js';
import { BaseLayout } from '../layouts/BaseLayout.js';

export interface HomePageProps extends PageProps {
  entries: RankedEntry[];
  playerCount: number;
  categoryCount: number;
  maxPoints: number;
  sort: SortKey;
  dir: SortDirection;
  query: string;
}

/**
 * 榜单首页。
 *
 * 页面的主角就是榜单本身，因此不做大 hero 卡：标题、统计、搜索、排序压缩成
 * 一行头部，紧接着就是数据。旧站的首页有近一屏的装饰区块才见到第一名。
 */
export function HomePage({
  ctx,
  entries,
  playerCount,
  categoryCount,
  maxPoints,
  sort,
  dir,
  query
}: HomePageProps) {
  const filtered = query.length > 0;

  return (
    <BaseLayout
      title="榜单总览"
      ctx={ctx}
      description="中文 Minecraft 1.9+ PvP Subtier 榜单，收录各细分项目的玩家定级。"
      scripts={['client/pages/board.ts']}
    >
      <div class="board-head">
        <div>
          <p class="eyebrow">1.9+ PVP SUBTIER</p>
          <h1>榜单总览</h1>
          <p class="board-stats">
            <span>
              <span class="board-stats__num">{playerCount}</span> 名玩家
            </span>
            <span>
              <span class="board-stats__num">{categoryCount}</span> 个细分项目
            </span>
          </p>
        </div>

        <div class="stack board-controls">
          <Form action="/" method="get" class="search-form">
            {/* 无脚本时提交表单由服务端过滤；有脚本时增强为即时过滤 */}
            <div class="search">
              <Icon name="search" />
              <input
                class="search__input"
                id="board-search"
                type="search"
                name="q"
                value={query}
                placeholder="搜索玩家、段位或项目"
                aria-label="搜索榜单"
                autocomplete="off"
              />
              <kbd class="kbd">Ctrl K</kbd>
            </div>
            {/* 搜索时保留当前排序 */}
            <input type="hidden" name="sort" value={sort} />
            <input type="hidden" name="dir" value={dir} />
          </Form>

          <SortBar sort={sort} dir={dir} query={query} />
        </div>
      </div>

      {/* 客户端过滤后由增强器更新这里的计数 */}
      <p class="visually-hidden" id="board-status" role="status" aria-live="polite">
        {filtered ? `找到 ${String(entries.length)} 条结果` : `共 ${String(entries.length)} 条`}
      </p>

      {entries.length === 0 ? (
        <EmptyState>
          {filtered ? `没有匹配「${query}」的玩家。换个关键词试试。` : '榜单还是空的。'}
        </EmptyState>
      ) : (
        <Board entries={entries} maxPoints={maxPoints} />
      )}
    </BaseLayout>
  );
}
