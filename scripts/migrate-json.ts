/**
 * 把旧站的 data/*.json 导入数据库。
 *
 *   npx tsx scripts/migrate-json.ts --dry-run      # 只出报告，不落盘
 *   npx tsx scripts/migrate-json.ts                # 实际导入
 *   npx tsx scripts/migrate-json.ts --db other.db  # 指定目标 SQLite 文件
 *   npx tsx scripts/migrate-json.ts --source /path/to/data
 *
 * 导入逻辑本体在 scripts/lib/legacyImport.ts（那里有测试覆盖）；
 * 本文件只负责参数解析、事务编排与报告输出。
 *
 * dry-run 是在事务内完整执行导入后回滚，因此报告与真实导入完全同源。
 *
 * **目标只支持 SQLite**（--db 收的是 data/ 下的文件名）。这与 CLAUDE.md 里
 * 部署步骤的顺序一致：先导进 SQLite，再用 /admin/database 面板迁移到 PostgreSQL /
 * MySQL——面板会复制数据并逐表核对，比在这里再写一套连接参数解析更可靠。
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createKysely, type DbConnectionConfig } from '../app/db/dialects.js';
import { DbManager } from '../app/db/manager.js';
import { runMigrations } from '../app/db/migrator.js';
import {
  findConflicts,
  findOversized,
  formatRanking,
  importLegacyData,
  type ImportReport,
  type LegacyEntry,
  type LegacySettings,
  type LegacyUser
} from './lib/legacyImport.js';

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');

function argValue(flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

const sourceDir = resolve(argValue('--source') ?? resolve(process.cwd(), 'data'));
const dbFile = argValue('--db') ?? 'subtier.db';

class DryRunRollback extends Error {
  constructor() {
    super('dry-run 回滚');
  }
}

async function readJsonFile<T>(name: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(resolve(sourceDir, name), 'utf-8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      console.warn(`· ${name} 不存在，按空数据处理`);
      return fallback;
    }
    throw error;
  }
}

async function main(): Promise<void> {
  console.log(`源目录：${sourceDir}`);
  console.log(`目标库：sqlite:${dbFile}${dryRun ? '  [dry-run]' : ''}\n`);

  const [users, entries, settings] = await Promise.all([
    readJsonFile<LegacyUser[]>('users.json', []),
    readJsonFile<LegacyEntry[]>('leaderboard.json', []),
    readJsonFile<LegacySettings>('settings.json', {})
  ]);

  console.log(`读入：${String(users.length)} 个用户、${String(entries.length)} 条榜单记录`);

  const conflicts = findConflicts(users);
  if (conflicts.length > 0) {
    console.error('\n✖ 发现只差大小写的重复记录，新库的唯一约束无法容纳，请先人工处理：');
    for (const conflict of conflicts) {
      console.error(`  ${conflict.kind} "${conflict.value}" → id: ${conflict.ids.join(', ')}`);
    }
    process.exitCode = 1;
    return;
  }

  /*
   * 长度检查必须在这里拦住，不能只是提示。
   *
   * 本脚本的目标固定是 SQLite，而 SQLite 不强制 varchar(n)：放行的话报告全绿、
   * 导入成功，直到日后用 /admin/database 迁移到 PostgreSQL / MySQL 时才在复制
   * 事务里炸掉。那时错误来自驱动层（`value too long for type character varying(48)`），
   * 既指不出是哪一行也指不出是旧数据的问题。
   */
  const oversized = findOversized({ users, entries, settings });
  if (oversized.length > 0) {
    console.error(
      '\n✖ 发现超出列宽的字段。SQLite 会照单全收，但切到 PostgreSQL / MySQL 时会失败：'
    );
    for (const item of oversized) {
      console.error(
        `  ${item.owner} 的 ${item.field}：${String(item.actual)} 字符 > 上限 ${String(item.limit)}  ${item.sample}`
      );
    }
    console.error('  请先在旧数据里缩短这些值后重跑。');
    process.exitCode = 1;
    return;
  }

  const superAdminName = (process.env['ADMIN_USERNAME'] ?? 'admin').trim();
  const dbConfig: DbConnectionConfig = { driver: 'sqlite', file: dbFile };
  const manager = new DbManager();
  await manager.switchTo(await createKysely(dbConfig), dbConfig);

  try {
    const { applied } = await runMigrations(manager.db());
    if (applied.length > 0) console.log(`已应用迁移：${applied.join(', ')}`);

    let report: ImportReport | undefined;
    try {
      await manager
        .db()
        .transaction()
        .execute(async (trx) => {
          report = await importLegacyData(
            trx,
            { users, entries, settings },
            superAdminName,
            dbConfig.driver
          );
          if (dryRun) throw new DryRunRollback();
        });
    } catch (error) {
      if (!(error instanceof DryRunRollback)) throw error;
    }

    if (!report) {
      console.error('✖ 导入未产出报告');
      process.exitCode = 1;
      return;
    }
    // 固定成 const，下面的闭包才能确定它不是 undefined
    const result: ImportReport = report;

    console.log('\n=== 导入报告 ===');
    const mergedNote =
      result.usersMerged > 0 ? `（其中 ${String(result.usersMerged)} 条与已有账号合并）` : '';
    console.log(`用户       ${String(result.users)} / ${String(users.length)}${mergedNote}`);
    console.log(`细分项目   ${String(result.categories)} 个新建`);
    console.log(`榜单条目   ${String(result.entries)} / ${String(entries.length)}`);
    console.log(`定级记录   ${String(result.tiers)}`);
    console.log(`设置项     ${String(result.settings)}`);
    console.log(`SuperAdmin ${result.superAdmins.join('、') || '（无）'}`);

    /*
     * 旧站把 role === 'admin' 也算作 SuperAdmin（scripts/lib/legacyImport.ts
     * 的 normalizeRole 沿用了这条规则），所以旧数据里有几个这样的账号，导入后
     * 就有几个 SuperAdmin。新站不允许对 SuperAdmin 降级或删除，多出来的那些
     * 在后台里动不了，必须在这里就让人看到。
     *
     * 判据不能只是「多于一个」：「恰好一个、但不是 ADMIN_USERNAME」同样是坑——
     * ensureSuperAdmin 见到已有别的 SuperAdmin 就只打一行 warn 返回，不会再创建
     * ADMIN_USERNAME 对应的账号，于是操作者手上一个能用的 SuperAdmin 都没有，
     * 而那个既有的又降不了级、删不掉。
     */
    if (result.superAdmins.length !== 1 || result.superAdmins[0] !== superAdminName) {
      console.warn(
        `\n⚠️  导入后的 SuperAdmin 是 [${result.superAdmins.join('、') || '（无）'}]，` +
          `而 ADMIN_USERNAME 指定的是 [${superAdminName}]。\n` +
          '  新站不允许对 SuperAdmin 降级或删除，也不会在「已有别的 SuperAdmin」时' +
          '再创建 ADMIN_USERNAME 账号。\n' +
          '  若这不是预期结果，请先改掉旧数据里相关账号的 role（或调整 ADMIN_USERNAME）再重跑导入。'
      );
    }

    for (const skipped of result.skippedRecords) {
      console.warn(`⚠️  跳过：${skipped}`);
    }
    if (result.skippedTiers.length > 0) {
      console.warn(`\n⚠️  ${String(result.skippedTiers.length)} 条定级找不到对应项目：`);
      for (const item of result.skippedTiers.slice(0, 10)) {
        console.warn(`  ${item.player} → ${item.category}`);
      }
    }

    if (result.rankingSample.length > 0) {
      console.log('\n导入后计算的前 10 名：');
      for (const line of result.rankingSample) console.log(`  ${line}`);

      // 与旧文件独立算一遍对比：position 会出现在公开 API 里，不能有偏移
      const legacyLines = formatRanking(
        entries
          .filter((entry) => (entry.player ?? '').trim() !== '')
          .map((entry) => ({ player: entry.player!, points: Number(entry.points ?? 0) }))
      );
      const matches =
        legacyLines.length === result.rankingSample.length &&
        legacyLines.every((line, index) => line === result.rankingSample[index]);
      console.log(matches ? '\n✓ 前 10 名与旧数据一致' : '\n✖ 前 10 名与旧数据不一致，请核查');
      if (!matches) process.exitCode = 1;
    }

    console.log(dryRun ? '\n[dry-run] 事务已回滚，未写入任何数据。' : '\n✓ 导入完成。');
  } finally {
    await manager.close();
  }
}

await main();
