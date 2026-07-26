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
      watch: false,
      kill_timeout: 6000,
      exp_backoff_restart_delay: 200,
      max_memory_restart: '512M'
    }
  ]
};
