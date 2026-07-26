import type { Page } from '../../../../services/leaderboardService.js';
import type { RankedEntry } from '../../../../types/domain.js';
import type { PageProps } from '../../../../types/view.js';
import { Field, Form } from '../../components/Form.js';
import { Icon } from '../../components/Icon.js';
import { Button, Card, EmptyState, LinkButton, Pagination, TierBadge } from '../../components/ui.js';
import { BaseLayout } from '../../layouts/BaseLayout.js';

export interface AdminEntriesProps extends PageProps {
  page: Page<RankedEntry>;
  /** 全部细分项目名，用于生成定级字段。 */
  categories: string[];
  stats: { entries: number; categories: number };
}

/**
 * 榜单条目管理。
 *
 * 每个条目有两条写入路径，与旧站一致但语义更清楚：
 *   - 快速编辑：只改积分 / 段位 / 测试服，定级不动
 *   - 完整编辑：连定级一起替换（折叠在 details 里，避免列表过长）
 */
export function AdminEntriesPage({ ctx, page, categories, stats }: AdminEntriesProps) {
  return (
    <BaseLayout title="条目管理" ctx={ctx} scripts={['client/pages/admin.ts']}>
      <div class="stack admin">
        <div class="admin__head">
          <div>
            <p class="eyebrow">ADMIN</p>
            <h1>条目管理</h1>
            <p class="admin__meta">
              共 {stats.entries} 条记录 · {stats.categories} 个细分项目
            </p>
          </div>
          <div class="cluster">
            <LinkButton href="/admin/categories">管理细分项目</LinkButton>
            <LinkButton href="/admin/export" variant="secondary">
              导出 CSV
            </LinkButton>
          </div>
        </div>

        <Card title="新增条目">
          <Form action="/admin/entries" csrfToken={ctx.csrfToken} class="stack admin__form">
            <div class="admin__grid">
              <Field name="player" label="玩家名" maxlength={32} required />
              <Field name="rank" label="段位" maxlength={64} value="Unranked" required />
              <Field name="points" label="积分" type="number" min={0} max={9999} value={0} required />
              <Field name="testServer" label="测试服" maxlength={64} hint="留空表示无" />
            </div>

            {categories.length > 0 && (
              <fieldset class="admin__fieldset">
                <legend>细分项目定级</legend>
                <p class="admin__hint">留空表示未定级。格式如 HT1 / LT3。</p>
                <div class="admin__grid">
                  {categories.map((name) => (
                    <Field key={name} name={`category__${name}`} label={name} maxlength={32} />
                  ))}
                </div>
              </fieldset>
            )}

            <Button variant="primary" pendingLabel="添加中…">
              添加条目
            </Button>
          </Form>
        </Card>

        <Card
          title="现有条目"
          actions={
            <div class="search admin__filter">
              <Icon name="search" />
              <input
                class="search__input"
                id="admin-filter"
                type="search"
                placeholder="筛选本页条目"
                aria-label="筛选条目"
                autocomplete="off"
              />
            </div>
          }
        >
          {page.items.length === 0 ? (
            <EmptyState>还没有任何条目。用上面的表单添加第一条。</EmptyState>
          ) : (
            <>
              <ul class="entry-list">
                {page.items.map((entry) => (
                  <EntryCard key={entry.id} entry={entry} categories={categories} ctx={ctx} />
                ))}
              </ul>
              <Pagination
                page={page.page}
                totalPages={page.totalPages}
                hrefFor={(target) => `/admin?page=${String(target)}`}
              />
            </>
          )}
        </Card>
      </div>
    </BaseLayout>
  );
}

function EntryCard({
  entry,
  categories,
  ctx
}: {
  entry: RankedEntry;
  categories: string[];
  ctx: PageProps['ctx'];
}) {
  return (
    <li class="entry" data-filter={buildFilterIndex(entry)}>
      <div class="entry__head">
        <span class="entry__position">#{entry.position}</span>
        <span class="entry__player">{entry.player}</span>
        <TierBadge rank={entry.rank} />
        <span class="entry__points">{entry.points}</span>
      </div>

      {/* 快速编辑：只动这三个字段 */}
      <Form action={`/admin/entries/${entry.id}/quick`} csrfToken={ctx.csrfToken} class="entry__quick">
        <Field name="rank" label="段位" value={entry.rank} maxlength={64} />
        <Field name="points" label="积分" type="number" value={entry.points} min={0} max={9999} />
        <Field name="testServer" label="测试服" value={entry.testServer ?? ''} maxlength={64} />
        <Button variant="secondary" small pendingLabel="保存中…">
          保存
        </Button>
      </Form>

      <details class="entry__details">
        <summary>完整编辑（含定级）</summary>
        <Form
          action={`/admin/entries/${entry.id}/update`}
          csrfToken={ctx.csrfToken}
          class="stack entry__full"
        >
          <div class="admin__grid">
            <Field name="player" label="玩家名" value={entry.player} maxlength={32} required />
            <Field name="rank" label="段位" value={entry.rank} maxlength={64} required />
            <Field
              name="points"
              label="积分"
              type="number"
              value={entry.points}
              min={0}
              max={9999}
              required
            />
            <Field
              name="testServer"
              label="测试服"
              value={entry.testServer ?? ''}
              maxlength={64}
            />
          </div>

          {categories.length > 0 && (
            <div class="admin__grid">
              {categories.map((name) => (
                <Field
                  key={name}
                  name={`category__${name}`}
                  label={name}
                  value={entry.tiers[name] ?? ''}
                  maxlength={32}
                />
              ))}
            </div>
          )}

          <div class="cluster">
            <Button variant="primary" pendingLabel="保存中…">
              保存全部修改
            </Button>
          </div>
        </Form>

        <Form
          action={`/admin/entries/${entry.id}/delete`}
          csrfToken={ctx.csrfToken}
          confirm={`确认删除 ${entry.player} 的条目？此操作无法撤销。`}
          class="entry__delete"
        >
          <Button variant="danger" small>
            删除条目
          </Button>
        </Form>
      </details>
    </li>
  );
}

/** 客户端筛选用的索引，服务端预先拼好。 */
function buildFilterIndex(entry: RankedEntry): string {
  return [entry.player, entry.rank, entry.id, entry.testServer ?? '', ...Object.entries(entry.tiers).flat()]
    .join(' ')
    .toLowerCase();
}
