/*
 * PM2 配置。
 *
 * 文件必须是 .cjs：根 package.json 已是 ESM，叫 .js 会被当模块解析而加载失败。
 *
 * 已切换到新站。启动前必须先 npm run build——script 指向的是构建产物，
 * dist/ 不在仓库里，忘了构建就是 "Script not found"。
 * 需要回滚到旧站：把 script 改回 'src/server.js'（或跑 npm run start:legacy）。
 */
module.exports = {
  apps: [
    {
      name: 'subtier',
      // 新站的构建产物（npm run build 生成）
      script: 'dist/server/server.js',
      /*
       * NODE_ENV 必须显式设。
       *
       * 新站把 SESSION_SECRET / APP_BASE_URL 的强制校验、会话 cookie 的 Secure、
       * CSP 的 upgrade-insecure-requests 全挂在它上面，而 PM2 默认不设它——
       * 漏掉的话这些保护一条都不会生效，并且**不会有任何报错**。
       * 启动日志会打出「（NODE_ENV=…）」，用它确认。
       *
       * 反过来说，有了它，.env 里缺 SESSION_SECRET（≥32 字符）或 APP_BASE_URL
       * 就是**拒绝启动**而不是降级——这是故意的，见 CLAUDE.md。PM2 会按
       * exp_backoff_restart_delay 反复重启并一直失败，此时去看 pm2 logs。
       */
      env: { NODE_ENV: 'production' },
      /*
       * 刻意不设 instances：必须是 fork 模式的单进程。
       *
       * 新站有若干进程内状态——维护模式标志、站点设置缓存、限流计数器，
       * 以及 DbManager 里那个「当前连接」指针。cluster 模式下这些各 worker
       * 一份：一次数据库切换只会移动其中一个 worker 的指针，其余 worker
       * 继续读写旧库，是不可控的数据分裂。要横向扩容必须先把这些状态外置。
       */
      watch: false,
      kill_timeout: 6000,
      exp_backoff_restart_delay: 200,
      max_memory_restart: '512M'
    }
  ]
};
