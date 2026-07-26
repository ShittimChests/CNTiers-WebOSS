import type { Kysely } from 'kysely';
import { createKysely, describeConnection, type DbConnectionConfig } from './dialects.js';
import type { Database } from './types.js';

/**
 * 当前数据库连接的持有者。
 *
 * 所有 repository 在每次调用时通过 `dbManager.db()` 取实例，而不是在构造时
 * 捕获引用 —— 这正是运行时热切库的支点：切换只是把这里的指针换掉，
 * 无需重启进程，也无需通知任何调用方。
 */
export class DbManager {
  #db: Kysely<Database> | null = null;
  #config: DbConnectionConfig | null = null;

  get isConnected(): boolean {
    return this.#db !== null;
  }

  db(): Kysely<Database> {
    if (!this.#db) {
      throw new Error('数据库尚未初始化：请先调用 dbManager.connect()。');
    }
    return this.#db;
  }

  currentConfig(): DbConnectionConfig {
    if (!this.#config) {
      throw new Error('数据库尚未初始化：请先调用 dbManager.connect()。');
    }
    return this.#config;
  }

  /** 首次建立连接。已连接时先关闭旧连接。 */
  async connect(dbConfig: DbConnectionConfig): Promise<void> {
    const next = await createKysely(dbConfig);
    await this.switchTo(next, dbConfig);
  }

  /**
   * 换上已经建好并校验过的连接。旧连接在指针切换之后才关闭，
   * 让进行中的查询自然收尾；关闭失败只记日志，不影响切换结果。
   */
  async switchTo(next: Kysely<Database>, dbConfig: DbConnectionConfig): Promise<void> {
    const previous = this.#db;
    this.#db = next;
    this.#config = dbConfig;

    if (previous) {
      try {
        await previous.destroy();
      } catch (error) {
        console.warn('关闭旧数据库连接时出错（已忽略）：', error);
      }
    }
    console.info(`数据库已连接：${describeConnection(dbConfig)}`);
  }

  async close(): Promise<void> {
    const current = this.#db;
    this.#db = null;
    this.#config = null;
    if (current) await current.destroy();
  }
}

/** 进程级单例。测试中可以自行 new 一个隔离实例。 */
export const dbManager = new DbManager();
