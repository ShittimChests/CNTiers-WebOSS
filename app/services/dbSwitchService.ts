import type { Kysely } from 'kysely';
import { saveDbConfig } from '../db/dbConfigFile.js';
import { createKysely, describeConnection, type DbConnectionConfig } from '../db/dialects.js';
import { dbManager, type DbManager } from '../db/manager.js';
import { currentMigrationVersion, runMigrations, LATEST_MIGRATION } from '../db/migrator.js';
import type { Database } from '../db/types.js';
import { AppError } from '../errors/AppError.js';
import { enterMaintenance, exitMaintenance } from '../web/middleware/maintenance.js';
import { settingsService } from './settingsService.js';

/**
 * 数据库切换。
 *
 * 安全性来自一条不变量：**active 指针在全部工作成功之前绝不移动**。
 * 任何一步失败，进程仍在用原来的库，只需丢掉目标连接即可，没有回滚动作。
 *
 * 顺序也是刻意的——先把数据复制完并校验，再写配置文件，最后才切指针：
 *   - 复制失败 → 配置未改、指针未动，重启后照旧
 *   - 写文件失败 → 指针未动，重启后照旧
 *   - 切指针后进程崩溃 → 配置已经指向新库，且新库数据完整
 */

/** 业务表的复制顺序，受外键约束。sessions 刻意不复制（切库后要求重新登录）。 */
const COPY_ORDER = [
  'users',
  'categories',
  'entries',
  'entry_tiers',
  'verification_codes',
  'settings'
] as const;

type CopyTable = (typeof COPY_ORDER)[number];

/** 一次插入的行数。SQLite 有 999 个绑定参数的上限，分批最稳。 */
const BATCH_SIZE = 100;

export interface ConnectionProbe {
  driver: DbConnectionConfig['driver'];
  summary: string;
  /** 目标库已执行到的迁移版本；从未迁移过为 null。 */
  migrationVersion: string | null;
  /** 各业务表的行数；表不存在时为 null。 */
  rowCounts: Record<string, number | null>;
  /** 结构完整且无业务数据。 */
  isEmpty: boolean;
  /** 结构版本与当前代码一致。 */
  schemaCurrent: boolean;
}

export type SwitchMode = 'migrate' | 'direct';

export interface SwitchResult {
  copied: Record<string, number>;
  summary: string;
}

export class DbSwitchService {
  #inProgress = false;

  constructor(private readonly manager: DbManager = dbManager) {}

  /** 探测目标库：能否连上、结构版本、有多少数据。不做任何写入。 */
  async probe(target: DbConnectionConfig): Promise<ConnectionProbe> {
    const db = await this.#connect(target);
    try {
      return await this.#probeWith(db, target);
    } finally {
      await db.destroy();
    }
  }

  /**
   * 探测**当前实际生效**的连接，复用已有连接。
   *
   * 这里刻意不读 db-config.json：配置文件是「下次启动用哪个库」，
   * 而面板要回答的是「现在连的是哪个库」。两者在配置刚被改过、
   * 或启动时走了 FORCE_SQLITE 回退的情况下并不一致。
   */
  async probeCurrent(): Promise<ConnectionProbe> {
    return this.#probeWith(this.manager.db(), this.manager.currentConfig());
  }

  /**
   * 切换到目标库。
   *
   * migrate 模式：目标须为空库，把当前数据搬过去。
   * direct  模式：目标已是本应用的库且结构版本一致，直接指过去（用于切回旧库）。
   */
  async switchTo(target: DbConnectionConfig, mode: SwitchMode): Promise<SwitchResult> {
    if (this.#inProgress) throw new AppError('db_switch_in_progress');
    this.#inProgress = true;

    let next: Kysely<Database> | null = null;
    try {
      next = await this.#connect(target);

      // 结构就绪
      try {
        await runMigrations(next);
      } catch (cause) {
        throw new AppError('db_migration_failed', { cause });
      }

      const probe = await this.#probeWith(next, target);

      if (mode === 'direct') {
        if (!probe.schemaCurrent) throw new AppError('db_schema_mismatch');
      } else if (!probe.isEmpty) {
        throw new AppError('db_target_not_empty', { meta: { rowCounts: probe.rowCounts } });
      }

      const copied: Record<string, number> = {};

      if (mode === 'migrate') {
        // 读请求继续走旧库，写请求挡住——否则复制期间的新数据只会落在旧库
        enterMaintenance('正在迁移数据库');
        try {
          await this.#copyAll(this.manager.db(), next, copied);
          await this.#verify(this.manager.db(), next);
        } catch (cause) {
          if (AppError.is(cause)) throw cause;
          throw new AppError('db_copy_failed', { cause });
        }
      }

      // 配置先落盘：此后即使立刻崩溃，重启也会连到已经装好数据的新库
      await saveDbConfig(target);

      const previous = this.manager.currentConfig();
      await this.manager.switchTo(next, target);
      next = null; // 所有权已交给 manager，finally 里不要再关它

      // 会话不跨库搬迁，全部作废
      await this.manager.db().deleteFrom('sessions').execute();
      settingsService.invalidate();

      console.info(`数据库已切换：${describeConnection(previous)} → ${describeConnection(target)}`);
      return { copied, summary: describeConnection(target) };
    } finally {
      exitMaintenance();
      this.#inProgress = false;
      // 失败路径：目标连接从未被启用，直接关掉
      if (next) await next.destroy().catch(() => undefined);
    }
  }

  async #connect(target: DbConnectionConfig): Promise<Kysely<Database>> {
    let db: Kysely<Database>;
    try {
      db = await createKysely(target);
    } catch (cause) {
      // 路径不合法等参数问题原样抛出
      if (AppError.is(cause)) throw cause;
      throw new AppError('db_connect_failed', { cause });
    }

    try {
      // 真正打一次往返，确认凭据与网络都通
      await db.executeQuery(db.selectFrom('sessions').select('sid').limit(0).compile());
    } catch {
      // 表不存在是正常的（空库），只有连接层失败才算错
      try {
        await db.introspection.getTables();
      } catch (cause) {
        await db.destroy().catch(() => undefined);
        throw new AppError('db_connect_failed', { cause });
      }
    }
    return db;
  }

  async #probeWith(db: Kysely<Database>, target: DbConnectionConfig): Promise<ConnectionProbe> {
    const migrationVersion = await currentMigrationVersion(db).catch(() => null);
    const rowCounts: Record<string, number | null> = {};
    let total = 0;
    for (const table of COPY_ORDER) {
      const count = await this.#countOrNull(db, table);
      rowCounts[table] = count;
      if (count !== null) total += count;
    }
    return {
      driver: target.driver,
      summary: describeConnection(target),
      migrationVersion,
      rowCounts,
      isEmpty: total === 0,
      schemaCurrent: migrationVersion === LATEST_MIGRATION
    };
  }

  async #countOrNull(db: Kysely<Database>, table: CopyTable): Promise<number | null> {
    try {
      const row = await db
        .selectFrom(table)
        .select((eb) => eb.fn.countAll<string | number>().as('total'))
        .executeTakeFirstOrThrow();
      return Number(row.total);
    } catch {
      // 表不存在
      return null;
    }
  }

  async #copyAll(
    source: Kysely<Database>,
    target: Kysely<Database>,
    copied: Record<string, number>
  ): Promise<void> {
    // 整体一个事务：中途失败不会在目标库留下半份数据
    await target.transaction().execute(async (trx) => {
      for (const table of COPY_ORDER) {
        const rows = await source.selectFrom(table).selectAll().execute();
        copied[table] = rows.length;
        if (rows.length === 0) continue;

        for (let index = 0; index < rows.length; index += BATCH_SIZE) {
          const batch = rows.slice(index, index + BATCH_SIZE);
          await trx.insertInto(table).values(batch).execute();
        }
      }
    });
  }

  /** 逐表比对行数，并抽样核对榜单前几名，确认搬迁没有静默丢数据。 */
  async #verify(source: Kysely<Database>, target: Kysely<Database>): Promise<void> {
    for (const table of COPY_ORDER) {
      const before = await this.#countOrNull(source, table);
      const after = await this.#countOrNull(target, table);
      if (before !== after) {
        throw new AppError('db_copy_failed', {
          meta: { table, expected: before, actual: after }
        });
      }
    }

    const sample = await source
      .selectFrom('entries')
      .select(['id', 'player', 'points'])
      .orderBy('points', 'desc')
      .orderBy('player', 'asc')
      .limit(5)
      .execute();

    for (const expected of sample) {
      const actual = await target
        .selectFrom('entries')
        .select(['player', 'points'])
        .where('id', '=', expected.id)
        .executeTakeFirst();
      const matches = actual?.player === expected.player && actual?.points === expected.points;
      if (!matches) {
        throw new AppError('db_copy_failed', { meta: { entryId: expected.id } });
      }
    }
  }
}

export const dbSwitchService = new DbSwitchService();
