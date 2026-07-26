import type { CategoryRow } from '../db/types.js';
import type { Category } from '../types/domain.js';
import { BaseRepository, lower, newId, nowIso } from './base.js';

function toCategory(row: CategoryRow): Category {
  return { id: row.id, name: row.name, createdAt: row.created_at };
}

/**
 * 细分项目现在是一等实体。
 *
 * 旧实现把「项目集合」定义为所有条目 categories 键的并集，于是新增/改名/删除
 * 都要遍历全表重写 JSON。独立成表后这些操作退化为单行写入 + 外键级联。
 */
export class CategoryRepository extends BaseRepository {
  async list(): Promise<Category[]> {
    const rows = await this.db
      .selectFrom('categories')
      .selectAll()
      .orderBy('name', 'asc')
      .execute();
    return rows.map(toCategory);
  }

  /** 只要名字，供公开 API 的 gamemodes 端点使用（字母序，契约的一部分）。 */
  async listNames(): Promise<string[]> {
    const rows = await this.db
      .selectFrom('categories')
      .select('name')
      .orderBy('name', 'asc')
      .execute();
    return rows.map((row) => row.name);
  }

  async findByName(name: string): Promise<Category | null> {
    const row = await this.db
      .selectFrom('categories')
      .selectAll()
      .where('name_lower', '=', lower(name))
      .executeTakeFirst();
    return row ? toCategory(row) : null;
  }

  async findById(id: string): Promise<Category | null> {
    const row = await this.db
      .selectFrom('categories')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? toCategory(row) : null;
  }

  async create(name: string): Promise<Category> {
    const row: CategoryRow = {
      id: newId('cat'),
      name,
      name_lower: lower(name),
      created_at: nowIso()
    };
    await this.db.insertInto('categories').values(row).execute();
    return toCategory(row);
  }

  async rename(id: string, nextName: string): Promise<void> {
    await this.db
      .updateTable('categories')
      .set({ name: nextName, name_lower: lower(nextName) })
      .where('id', '=', id)
      .execute();
  }

  /** 关联的定级记录由外键级联删除。 */
  async delete(id: string): Promise<boolean> {
    const result = await this.db.deleteFrom('categories').where('id', '=', id).executeTakeFirst();
    return Number(result.numDeletedRows ?? 0) > 0;
  }

  /** 按名字批量确保存在，返回名字→id。JSON 迁移与批量导入用。 */
  async ensureMany(names: readonly string[]): Promise<Map<string, string>> {
    const existing = await this.db.selectFrom('categories').select(['id', 'name']).execute();
    const idByName = new Map(existing.map((row) => [row.name, row.id]));

    const missing = names.filter((name) => !idByName.has(name));
    if (missing.length > 0) {
      const timestamp = nowIso();
      const rows = missing.map((name) => ({
        id: newId('cat'),
        name,
        name_lower: lower(name),
        created_at: timestamp
      }));
      await this.db.insertInto('categories').values(rows).execute();
      for (const row of rows) idByName.set(row.name, row.id);
    }

    return idByName;
  }
}

export const categoryRepository = new CategoryRepository();
