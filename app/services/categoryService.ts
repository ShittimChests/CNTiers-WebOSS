import { AppError } from '../errors/AppError.js';
import { categoryRepository, type CategoryRepository } from '../repositories/categoryRepository.js';
import type { Category } from '../types/domain.js';

/**
 * 细分项目管理。
 *
 * 旧实现把项目集合定义为所有条目 categories 键的并集，于是每次增删改都要
 * 遍历全表重写 JSON。现在项目是独立实体，这三个操作各自只动一行，
 * 删除时相关定级由外键级联清理。
 */
export class CategoryService {
  constructor(private readonly categories: CategoryRepository = categoryRepository) {}

  list(): Promise<Category[]> {
    return this.categories.list();
  }

  /** 名字列表（字母序）。公开 API 的 gamemodes 端点直接用它。 */
  listNames(): Promise<string[]> {
    return this.categories.listNames();
  }

  async add(name: string): Promise<Category> {
    const trimmed = name.trim();
    if (await this.categories.findByName(trimmed)) {
      throw new AppError('category_exists', { meta: { name: trimmed } });
    }
    return this.categories.create(trimmed);
  }

  /** 改名。目标名已被别的项目占用时拒绝；改成自身的大小写变体是允许的。 */
  async rename(from: string, to: string): Promise<void> {
    const source = await this.categories.findByName(from);
    if (!source) throw new AppError('category_not_found', { meta: { name: from } });

    const target = to.trim();
    const existing = await this.categories.findByName(target);
    if (existing && existing.id !== source.id) {
      throw new AppError('category_exists', { meta: { name: target } });
    }

    await this.categories.rename(source.id, target);
  }

  async remove(name: string): Promise<void> {
    const category = await this.categories.findByName(name);
    if (!category) throw new AppError('category_not_found', { meta: { name } });
    await this.categories.delete(category.id);
  }
}

export const categoryService = new CategoryService();
