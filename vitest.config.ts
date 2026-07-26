import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Vitest 4 走 oxc transform（不再是 esbuild）；JSX 要转成 preact 的自动运行时
  oxc: {
    jsx: {
      runtime: 'automatic',
      importSource: 'preact'
    }
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    exclude: ['node_modules/**', 'dist/**', 'src/**'],
    /*
     * 服务型数据库下必须串行跑。
     *
     * SQLite 用的是 `:memory:`，每个 worker 一个独立的库，天然隔离；而
     * PostgreSQL / MySQL 全部测试文件连的是同一个 `subtier_test`。createTestDb()
     * 在每个文件开头 drop 掉所有表再重跑迁移，db.reset() 又在每个 beforeEach
     * 清空所有行——并行时这些动作会打在别的 worker 正在用的数据上。
     *
     * 症状很具体，别误诊成方言问题：读回来的 tiers 是 `{}`、
     * `verification_codes` 撞外键（users 被清空了）、`delete from entry_tiers`
     * 死锁、以及「更新后找不到用户」。
     *
     * 真正的隔离要给每个 worker 分配独立 schema/database，代价不小；当前只有
     * repository 一套测试跑在服务型数据库上，串行足够，也更容易看懂失败。
     */
    fileParallelism: (process.env['TEST_DIALECT'] ?? 'sqlite') === 'sqlite',
    coverage: {
      provider: 'v8',
      include: ['app/**/*.ts', 'app/**/*.tsx'],
      exclude: ['app/client/**', 'app/**/*.d.ts']
    }
  }
});
