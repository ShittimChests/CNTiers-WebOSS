/*
 * PM2 配置。
 *
 * 文件必须是 .cjs：根 package.json 已是 ESM，叫 .js 会被当模块解析而加载失败。
 *
 * 切换到新站时把 script 改成 'dist/server/server.js'（先跑 npm run build），
 * 完整步骤见 CLAUDE.md 的「上线切换清单」。
 */
module.exports = {
  apps: [
    {
      name: 'subtier',
      // 现役旧站；切换后改为 'dist/server/server.js'
      script: 'src/server.js',
      /*
       * 切到新站时必须同时加上：
       *   env: { NODE_ENV: 'production' }
       *
       * 新站把 SESSION_SECRET / APP_BASE_URL 的强制校验、会话 cookie 的 Secure、
       * CSP 的 upgrade-insecure-requests 全挂在 NODE_ENV 上。不设的话这些保护
       * 一条都不生效，且不会报错。这里刻意不提前加：现在跑的还是旧站，
       * 旧站在 production 下会把 cookie 切成 Secure，属于线上行为变更，
       * 应当与切换同一步进行。
       */
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
