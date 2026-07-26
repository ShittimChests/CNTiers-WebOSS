import { ADMIN_PAGE_SIZE } from '../config/constants.js';
import { AppError } from '../errors/AppError.js';
import { categoryRepository, type CategoryRepository } from '../repositories/categoryRepository.js';
import { entryRepository, type EntryRepository } from '../repositories/entryRepository.js';
import type { Entry, EntryQuickPatch, NewEntry, RankedEntry } from '../types/domain.js';
import { toCsv } from '../utils/csv.js';
import { rankEntries } from '../utils/ranking.js';

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export type SortKey = 'position' | 'player' | 'points' | 'rank';
export type SortDirection = 'asc' | 'desc';

/**
 * 榜单读写。
 *
 * position 在这里产生：读全表 → rankEntries 计算名次。旧实现把它存进
 * JSON，于是每改一个字段都要重排并重写整个文件；现在它只是读取时的投影。
 */
export class LeaderboardService {
  constructor(
    private readonly entries: EntryRepository = entryRepository,
    private readonly categories: CategoryRepository = categoryRepository
  ) {}

  /** 全部条目，带名次。榜单规模是几百条，一次读全表即可。 */
  async listRanked(): Promise<RankedEntry[]> {
    const all = await this.entries.listWithTiers();
    return rankEntries(all);
  }

  /**
   * 服务端排序。默认按名次升序（即积分降序）。
   * 排序在服务端做，客户端 JS 只是增强——无脚本时页面依然可排序。
   */
  async listSorted(
    sort: SortKey = 'position',
    direction: SortDirection = 'asc'
  ): Promise<RankedEntry[]> {
    const ranked = await this.listRanked();
    const factor = direction === 'asc' ? 1 : -1;

    const sorted = [...ranked].sort((a, b) => {
      switch (sort) {
        case 'player':
          return a.player.localeCompare(b.player) * factor;
        case 'points':
          return (a.points - b.points) * factor;
        case 'rank':
          return a.rank.localeCompare(b.rank) * factor;
        case 'position':
        default:
          return (a.position - b.position) * factor;
      }
    });
    return sorted;
  }

  /** 按玩家名过滤（大小写不敏感，同时匹配段位与细分项目名）。 */
  async search(query: string): Promise<RankedEntry[]> {
    return filterByQuery(await this.listRanked(), query);
  }

  /**
   * 首页需要的一次性读取：排序 + 过滤 + 积分槽基准。
   *
   * maxPoints 取的是**全榜**最高分而非过滤后的最高分，
   * 这样搜索时积分槽的比例不会突然变化。
   */
  async listForBoard(options: {
    sort: SortKey;
    dir: SortDirection;
    query: string;
  }): Promise<{ entries: RankedEntry[]; total: number; maxPoints: number }> {
    const sorted = await this.listSorted(options.sort, options.dir);
    const maxPoints = sorted.reduce((max, entry) => Math.max(max, entry.points), 0);

    return {
      entries: filterByQuery(sorted, options.query),
      total: sorted.length,
      maxPoints
    };
  }

  /** 后台列表分页。页码从 1 开始，越界时收敛到有效范围。 */
  async listPaged(page: number, pageSize: number = ADMIN_PAGE_SIZE): Promise<Page<RankedEntry>> {
    const ranked = await this.listRanked();
    const total = ranked.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const current = Math.min(Math.max(1, page), totalPages);
    const start = (current - 1) * pageSize;

    return {
      items: ranked.slice(start, start + pageSize),
      page: current,
      pageSize,
      total,
      totalPages
    };
  }

  async getById(id: string): Promise<Entry> {
    const entry = await this.entries.findById(id);
    if (!entry) throw new AppError('entry_not_found');
    return entry;
  }

  async create(input: NewEntry): Promise<Entry> {
    return this.entries.create(input);
  }

  async update(id: string, input: NewEntry): Promise<Entry> {
    await this.getById(id);
    return this.entries.update(id, input);
  }

  /** 局部更新，细分项目不受影响。 */
  async quickUpdate(id: string, patch: EntryQuickPatch): Promise<Entry> {
    await this.getById(id);
    return this.entries.quickUpdate(id, patch);
  }

  async delete(id: string): Promise<void> {
    const deleted = await this.entries.delete(id);
    // 旧实现无论目标是否存在都报成功，掩盖了误删与并发删除
    if (!deleted) throw new AppError('entry_not_found');
  }

  async stats(): Promise<{ entries: number; categories: number }> {
    const [entries, categories] = await Promise.all([
      this.entries.count(),
      this.categories.listNames()
    ]);
    return { entries, categories: categories.length };
  }

  /**
   * CSV 导出。列顺序为固定字段 + 全部细分项目（按名字排序），
   * 未定级留空。BOM 由 toCsv 负责，缺了 Excel 会把中文列读成乱码。
   */
  async exportCsv(): Promise<string> {
    const [ranked, categoryNames] = await Promise.all([
      this.listRanked(),
      this.categories.listNames()
    ]);

    const headers = ['position', 'player', 'rank', 'points', 'testServer', ...categoryNames];
    const rows = ranked.map((entry) => [
      entry.position,
      entry.player,
      entry.rank,
      entry.points,
      entry.testServer ?? '',
      ...categoryNames.map((name) => entry.tiers[name] ?? '')
    ]);

    return toCsv(headers, rows);
  }
}

/** 搜索覆盖玩家名、段位、测试服与全部细分项目名及其定级。 */
function filterByQuery(entries: RankedEntry[], query: string): RankedEntry[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return entries;

  return entries.filter((entry) => {
    const haystack = [
      entry.player,
      entry.rank,
      entry.testServer ?? '',
      ...Object.entries(entry.tiers).flat()
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes(needle);
  });
}

export const leaderboardService = new LeaderboardService();
