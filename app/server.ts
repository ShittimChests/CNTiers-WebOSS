import { mkdir } from 'node:fs/promises';
import { createApp } from './app.js';
import { HEADERS_TIMEOUT_MS, KEEP_ALIVE_TIMEOUT_MS } from './config/constants.js';
import { config } from './config/env.js';
import { loadDbConfig } from './db/dbConfigFile.js';
import { describeConnection } from './db/dialects.js';
import { dbManager } from './db/manager.js';
import { runMigrations } from './db/migrator.js';
import { ensureSuperAdmin } from './services/superAdminSeed.js';

/**
 * 启动顺序是有依赖的：
 *   1. 确保数据目录存在（SQLite 文件要落在里面）
 *   2. 读连接配置 → 建连接 → 跑迁移（这三步之后数据层才可用）
 *   3. 保障 SuperAdmin 不变量
 *   4. 开始监听
 *
 * 任何一步失败都直接退出并说明原因，不做静默降级。
 */
async function bootstrap(): Promise<void> {
  await mkdir(config.dataDir, { recursive: true });

  const dbConfig = await loadDbConfig();
  try {
    await dbManager.connect(dbConfig);
  } catch (error) {
    console.error(
      `✖ 无法连接数据库（${describeConnection(dbConfig)}）：`,
      error instanceof Error ? error.message : error
    );
    console.error(
      '  若目标数据库不可用，可设置 FORCE_SQLITE=1 强制回退到本地 SQLite，' +
        '或直接编辑/删除 data/db-config.json。'
    );
    process.exit(1);
  }

  const { applied } = await runMigrations(dbManager.db());
  if (applied.length > 0) console.info(`已应用数据库迁移：${applied.join(', ')}`);

  await ensureSuperAdmin();

  const app = createApp();
  const server = app.listen(config.port, () => {
    // 把 env 一起打出来：生产环境的必填项校验、secure cookie 与 CSP 升级
    // 全都挂在 NODE_ENV 上，运维必须能一眼看出这次跑的是哪个模式
    console.info(`CNTiers 已启动：${config.appBaseUrl}（NODE_ENV=${config.env}）`);
  });

  /*
   * Cloudflare Tunnel 前置时，keepAlive 必须短于 headers 超时，
   * 否则 cloudflared 会在连接复用竞态下偶发 502。
   */
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;

  const shutdown = (signal: string): void => {
    console.info(`收到 ${signal}，开始优雅关闭…`);
    server.close(() => {
      void dbManager.close().then(() => process.exit(0));
    });
    // 兜底：连接迟迟不释放时强制退出，避免 PM2 一直等
    setTimeout(() => process.exit(1), 8000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('uncaughtException', (error) => {
    console.error('[fatal] 未捕获异常：', error);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[fatal] 未处理的 Promise 拒绝：', reason);
  });
}

await bootstrap();
