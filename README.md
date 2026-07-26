# CN Subtiers

中文 Minecraft 1.9+ PvP Subtier 榜单网站。

- 公开榜单：搜索、多列排序、段位徽章、各细分项目定级
- 账号体系：注册（邮箱验证码）、密码重置、Microsoft 账户登录与绑定
- 管理后台：条目增删改、细分项目管理、站点设置、用户管理、CSV 导出
- 数据库可切换：默认 SQLite 零配置，可在后台切到 PostgreSQL 或 MySQL
- 公开只读 API：`/api/v1/`，供外部机器人使用

## 快速开始

需要 **Node 22 或更高版本**。

```bash
npm install
cp .env.example .env      # 至少填 SESSION_SECRET
npm run build             # 构建前端资产与服务端产物
npm run dev               # 开发模式（另开一个终端跑 npm run dev:assets）
```

访问 `http://localhost:3000/`。首次启动会用 `ADMIN_USERNAME` / `ADMIN_PASSWORD`
创建管理员账号（默认 `admin` / `ChangeMe_12345`，请尽快修改）。

数据默认落在 `data/subtier.db`（SQLite）。要从旧版的 JSON 数据导入：

```bash
npm run db:import -- --dry-run    # 先看报告，不写入
npm run db:import                 # 正式导入（幂等，可重跑）
```

## 环境变量

参考 `.env.example`。生产环境必须设置 `SESSION_SECRET`——它同时用于会话签名与
验证码派生，缺失时进程会拒绝启动。

注册与密码重置需要 `RESEND_API_KEY` 与 `EMAIL_FROM`；Microsoft 登录需要
`MS_OAUTH_CLIENT_ID`（也可在后台填）与 `MS_OAUTH_CLIENT_SECRET`（只能放环境变量）。

## 部署

```bash
npm ci
npm run build
pm2 start ecosystem.config.cjs
```

应用名 `subtier`，512M 内存重启阈值。站点设计为跑在 Cloudflare Tunnel 之后
（`trust proxy` 设为一跳）。

## 数据库

默认 SQLite，单文件零运维。需要切到 PostgreSQL 或 MySQL 时，以超级管理员身份进入
**后台 → 数据库**：先「测试连接」确认可达，再「迁移并切换」把现有数据搬过去。

切换过程中读请求照常，写请求短暂返回 503；任何一步失败都会保持使用原数据库。
切换完成后所有人需要重新登录（会话不跨库搬迁）。

目标数据库宕机导致进程起不来时，设 `FORCE_SQLITE=1` 强制回退，或删除
`data/db-config.json`。

## 开放 API

只读 JSON 接口，公开访问、允许跨域、无需鉴权。按 IP 限流 60 次/分钟，
成功响应缓存 60 秒。完整说明见站内 `/api/docs`。

```bash
# 全部细分项目
curl http://localhost:3000/api/v1/gamemodes

# 总榜（默认 50 条）
curl 'http://localhost:3000/api/v1/rankings?limit=20&offset=0'

# 某个项目的定级榜（5 个 tier 桶，count 是每桶条数）
curl 'http://localhost:3000/api/v1/rankings/Sword?count=10'

# 单个玩家（含全部项目的定级，未定级为 null）
curl http://localhost:3000/api/v1/players/SharkIrene
```

错误响应统一为 `{ "error": "code", "message": "..." }`。错误码：`invalid_query` (400)、
`not_found` / `gamemode_not_found` (404)、`rate_limited` (429)、`internal_error` (500)。

v1 的字段只增不改；破坏性调整会以 v2 路径发布。

## 开发

```bash
npm run typecheck   # 类型检查
npm run lint        # eslint + stylelint + prettier
npm test            # vitest
npm run build       # 产物
```

其它检查：`check:inline`（视图层零内联样式/事件）、`check:contrast`（设计 token 对比度）、
`check:budget`（前端产物体积预算）。开发模式下 `/styleguide` 可以看到全部组件。

技术栈：TypeScript、Express 5、Preact（服务端渲染，无 hydration）、Kysely、
Vite、Vitest。详细架构说明见 `CLAUDE.md`。
