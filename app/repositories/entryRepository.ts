import type { Transaction } from 'kysely';
import type { Database, EntryRow, EntryRowUpdate } from '../db/types.js';
import type { Entry, EntryQuickPatch, NewEntry } from '../types/domain.js';
import { BaseRepository, lower, newId, nowIso } from './base.js';

function toEntry(row: EntryRow, tiers: Record<string, string>): Entry {
  return {
    id: row.id,
    player: row.player,
    rank: row.rank_label,
    points: row.points,
    testServer: row.test_server,
    tiers,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export class EntryRepository extends BaseRepository {
  /**
   * 读全部条目并组装细分项目。
   *
   * 两次查询后在内存里拼装，而不是让数据库做行转列：榜单规模是几百条，
   * 两次全表扫描远比在三种方言里各写一套透视 SQL 更可控。
   */
  async listWithTiers(): Promise<Entry[]> {
    const [rows, tierRows] = await Promise.all([
      this.db.selectFrom('entries').selectAll().execute(),
      this.db
        .selectFrom('entry_tiers')
        .innerJoin('categories', 'categories.id', 'entry_tiers.category_id')
        .select(['entry_tiers.entry_id', 'categories.name', 'entry_tiers.tier'])
        .execute()
    ]);

    const tiersByEntry = new Map<string, Record<string, string>>();
    for (const tier of tierRows) {
      let bucket = tiersByEntry.get(tier.entry_id);
      if (!bucket) {
        bucket = {};
        tiersByEntry.set(tier.entry_id, bucket);
      }
      bucket[tier.name] = tier.tier;
    }

    return rows.map((row) => toEntry(row, tiersByEntry.get(row.id) ?? {}));
  }

  async findById(id: string): Promise<Entry | null> {
    const row = await this.db
      .selectFrom('entries')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) return null;
    return toEntry(row, await this.#loadTiers(id));
  }

  /** 玩家名查找不区分大小写；重名时取最早创建的一条。 */
  async findByPlayer(player: string): Promise<Entry | null> {
    const row = await this.db
      .selectFrom('entries')
      .selectAll()
      .where('player_lower', '=', lower(player))
      .orderBy('created_at', 'asc')
      .executeTakeFirst();
    if (!row) return null;
    return toEntry(row, await this.#loadTiers(row.id));
  }

  async create(input: NewEntry): Promise<Entry> {
    const timestamp = nowIso();
    const id = newId('entry');
    const row: EntryRow = {
      id,
      player: input.player,
      player_lower: lower(input.player),
      rank_label: input.rank,
      points: input.points,
      test_server: input.testServer,
      created_at: timestamp,
      updated_at: timestamp
    };

    await this.db.transaction().execute(async (trx) => {
      await trx.insertInto('entries').values(row).execute();
      await this.#writeTiers(trx, id, input.tiers);
    });

    return toEntry(row, input.tiers);
  }

  /** 全量更新：基础字段与细分项目一并替换。 */
  async update(id: string, input: NewEntry): Promise<Entry> {
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('entries')
        .set({
          player: input.player,
          player_lower: lower(input.player),
          rank_label: input.rank,
          points: input.points,
          test_server: input.testServer,
          updated_at: nowIso()
        })
        .where('id', '=', id)
        .execute();

      await trx.deleteFrom('entry_tiers').where('entry_id', '=', id).execute();
      await this.#writeTiers(trx, id, input.tiers);
    });

    const updated = await this.findById(id);
    if (!updated) throw new Error(`更新后找不到条目 ${id}`);
    return updated;
  }

  /** 局部更新，细分项目原样保留。只写调用方实际给出的字段。 */
  async quickUpdate(id: string, patch: EntryQuickPatch): Promise<Entry> {
    const values: EntryRowUpdate = { updated_at: nowIso() };
    if (patch.rank !== undefined) values.rank_label = patch.rank;
    if (patch.points !== undefined) values.points = patch.points;
    if (patch.testServer !== undefined) values.test_server = patch.testServer;

    await this.db.updateTable('entries').set(values).where('id', '=', id).execute();

    const updated = await this.findById(id);
    if (!updated) throw new Error(`更新后找不到条目 ${id}`);
    return updated;
  }

  /** 返回是否真的删掉了——旧实现无论目标是否存在都报成功。 */
  async delete(id: string): Promise<boolean> {
    const result = await this.db.deleteFrom('entries').where('id', '=', id).executeTakeFirst();
    return Number(result.numDeletedRows ?? 0) > 0;
  }

  async count(): Promise<number> {
    const row = await this.db
      .selectFrom('entries')
      .select((eb) => eb.fn.countAll<string | number>().as('total'))
      .executeTakeFirstOrThrow();
    return Number(row.total);
  }

  async #loadTiers(entryId: string): Promise<Record<string, string>> {
    const rows = await this.db
      .selectFrom('entry_tiers')
      .innerJoin('categories', 'categories.id', 'entry_tiers.category_id')
      .select(['categories.name', 'entry_tiers.tier'])
      .where('entry_tiers.entry_id', '=', entryId)
      .execute();

    const out: Record<string, string> = {};
    for (const row of rows) out[row.name] = row.tier;
    return out;
  }

  /**
   * 按项目名写入定级。名字查不到对应项目的静默跳过——项目可能刚被删掉。
   *
   * 查找走 `name_lower` 而不是 `name`：这是全仓库对「大小写不敏感查找」的统一
   * 约定（见 base.ts 的 lower），也是唯一能在三方言下行为一致的写法——MySQL 的
   * 默认排序规则是 `utf8mb4_0900_ai_ci`，`where name in (...)` 在那里本来就不区分
   * 大小写，而 PostgreSQL 与 SQLite 区分。用 `name` 会让同一份表单在不同库上
   * 一个写进去、一个静默丢掉。
   */
  async #writeTiers(
    trx: Transaction<Database>,
    entryId: string,
    tiers: Record<string, string>
  ): Promise<void> {
    const names = Object.keys(tiers);
    if (names.length === 0) return;

    const categories = await trx
      .selectFrom('categories')
      .select(['id', 'name_lower'])
      .where(
        'name_lower',
        'in',
        names.map((name) => lower(name))
      )
      .execute();

    const idByLower = new Map(categories.map((c) => [c.name_lower, c.id]));
    // 只差大小写的两个键指向同一行，去重否则撞 (entry_id, category_id) 主键
    const seen = new Set<string>();
    const values: { entry_id: string; category_id: string; tier: string }[] = [];
    for (const name of names) {
      const categoryId = idByLower.get(lower(name));
      if (!categoryId || seen.has(categoryId)) continue;
      seen.add(categoryId);
      values.push({ entry_id: entryId, category_id: categoryId, tier: tiers[name]! });
    }

    if (values.length > 0) {
      await trx.insertInto('entry_tiers').values(values).execute();
    }
  }
}

export const entryRepository = new EntryRepository();
