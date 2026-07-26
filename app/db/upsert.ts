import type { InsertQueryBuilder, InsertResult, OnConflictBuilder, UpdateObject } from 'kysely';
import type { DbDriver } from './dialects.js';
import type { Database } from './types.js';

/**
 * `doUpdateSet` 期望的入参类型。
 *
 * 从 builder 上推导而不是直接写出来：它实际是
 * `UpdateObjectExpression<OnConflictDatabase<…>, OnConflictTables<…>, …>`，
 * 而那几个名字没有从 kysely 的入口导出，写死会在升级时悄悄失配。
 */
type DoUpdateSetArg<TB extends keyof Database> = Parameters<
  OnConflictBuilder<Database, TB>['doUpdateSet']
>[0];

/**
 * 跨方言的 upsert。
 *
 * **Kysely 的 `onConflict()` 不是三方言通用的。** 它是 PostgreSQL / SQLite 的语法，
 * 而 `MysqlQueryCompiler` 并不会把它翻译成 MySQL 的写法——它照原样输出
 * `on conflict (...) do update set ...`，MySQL 直接 `ER_PARSE_ERROR`。
 * MySQL 的 upsert 是 `ON DUPLICATE KEY UPDATE`，必须走 `onDuplicateKeyUpdate()`。
 *
 * 这个坑很安静：SQLite（默认）与 PostgreSQL 都正常，只有 MySQL 会炸，而炸的是
 * 会话写入、设置保存与验证码签发——也就是登录、后台保存、注册这三条主路径。
 *
 * 两种语法有一点语义差异，用之前要确认：`ON DUPLICATE KEY UPDATE` 对**任意**
 * 唯一键冲突生效，而 `ON CONFLICT (cols)` 只针对指定的那一组列。本仓库调用这个
 * 助手的四张表（sessions / settings / verification_codes / entries）都只有主键
 * 一个唯一约束，所以两者等价。若将来给这些表加了别的唯一索引，必须重新审。
 *
 * `tests/unit/upsert.test.ts` 会把三种方言的 SQL 都编译出来比对——那是这条约束
 * 唯一的本地守卫，CI 的 MySQL 矩阵太远、太慢，不该是第一道防线。
 */
export function upsertRow<TB extends keyof Database>(
  query: InsertQueryBuilder<Database, TB, InsertResult>,
  driver: DbDriver,
  conflictColumns: readonly (keyof Database[TB] & string)[],
  updates: UpdateObject<Database, TB>
): InsertQueryBuilder<Database, TB, InsertResult> {
  if (driver === 'mysql') {
    // MySQL 不接受冲突列，靠表上的唯一键自行判定（见上面的语义说明）
    return query.onDuplicateKeyUpdate(updates);
  }
  return query.onConflict((oc) =>
    oc.columns(conflictColumns).doUpdateSet(
      /*
       * 两个 update 对象在运行时是同一个东西（都是「列名 → 标量」），但
       * `doUpdateSet` 的类型把表重映射成 `OnConflictDatabase`（多一个 `excluded`
       * 别名表），TS 无法在泛型层面证明二者等价。本函数的入参只接受标量、
       * 不接受表达式，所以这次收窄是安全的；换成表达式就必须重新审。
       */
      updates as DoUpdateSetArg<TB>
    )
  );
}
