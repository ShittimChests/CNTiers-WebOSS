import type { SortDirection, SortKey } from '../../../services/leaderboardService.js';
import { Icon } from './Icon.js';

const SORTS: { key: SortKey; label: string }[] = [
  { key: 'position', label: '名次' },
  { key: 'player', label: '玩家' },
  { key: 'points', label: '积分' },
  { key: 'rank', label: '段位' }
];

interface SortBarProps {
  sort: SortKey;
  dir: SortDirection;
  /** 保留搜索词，切换排序时不该丢掉用户输入。 */
  query: string;
}

/**
 * 排序控件。
 *
 * 输出的是普通链接：排序由服务端按 URL 参数完成，因此无脚本时完全可用。
 * 客户端增强只是拦截点击后就地重排 DOM，比较键直接取行上的 data-* 属性，
 * 不含第二份业务逻辑。
 *
 * 桌面与移动共用这一个组件——旧站为移动端另写了一整套下拉排序，
 * 选项文案硬编码三遍，且两套状态互不同步。
 */
export function SortBar({ sort, dir, query }: SortBarProps) {
  return (
    <div class="sortbar" data-enhance="sort">
      <span class="sortbar__label" id="sort-label">
        排序
      </span>
      {SORTS.map((option) => {
        const active = option.key === sort;
        // 点当前项翻转方向，点其他项从升序开始
        const nextDir: SortDirection = active && dir === 'asc' ? 'desc' : 'asc';
        const params = new URLSearchParams({ sort: option.key, dir: nextDir });
        if (query) params.set('q', query);

        return (
          <a
            key={option.key}
            class="sortbar__link"
            href={`/?${params.toString()}`}
            aria-current={active ? 'true' : undefined}
            data-sort={option.key}
            data-dir={nextDir}
          >
            {option.label}
            {active && (
              <>
                <Icon name={dir === 'asc' ? 'sort-asc' : 'sort-desc'} />
                <span class="visually-hidden">
                  {`当前按${option.label}${dir === 'asc' ? '升序' : '降序'}`}
                </span>
              </>
            )}
          </a>
        );
      })}
    </div>
  );
}
