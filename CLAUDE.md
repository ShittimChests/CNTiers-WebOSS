# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> ## ⚠️ 仓库当前是双栈：新站已建成，等待切换
>
> |      | 目录                       | 模块格式                               | 状态                                           |
> | ---- | -------------------------- | -------------------------------------- | ---------------------------------------------- |
> | 新站 | `app/` `scripts/` `tests/` | ESM                                    | **已完成 M0–M7，全部门禁绿**。尚未接管线上流量 |
> | 旧站 | `src/` `views/` `public/`  | CommonJS（靠 `src/package.json` 保护） | 线上跑的仍是它。除修 bug 外不要动              |
>
> 切换步骤见文末「上线切换清单」。**在用户明确决定切换之前，不要删除 `src/`/`views/`/`public/`，
> 也不要改 `package.json` 的 `start` 或 `ecosystem.config.cjs` 的 `script`。**
>
> 新代码的硬性约定：
>
> - **Node ≥ 22**（`better-sqlite3` 13 的要求）。开发机是 nvm 装的 v26；非交互 shell 需先
>   `export PATH="$HOME/.nvm/versions/node/v26.5.0/bin:$PATH"`，否则会落到系统 Node 18 并段错误。
> - **TypeScript 锁在 5.x**：TS 7 移除了 `moduleResolution: node10`，且 typescript-eslint 的 peer 范围是 `<6.1`。
> - **相对导入必须带 `.js` 扩展名**（Node ESM 要求；Vite 与 tsc 都能解析到 `.ts` 源文件）。
> - 根 `package.json` 是 ESM，所以 PM2 配置必须叫 `ecosystem.config.cjs`。
> - 重写计划：`/home/cyterx/.claude/plans/mutable-purring-rivest.md`

## Commands

```bash
npm run dev            # tsx watch app/server.ts（新站）
npm run dev:assets     # vite build --watch（改 CSS / 客户端 TS 时另开一个终端）
npm run dev:legacy     # nodemon src/server.js（旧站）
npm start              # 现役旧站；切换后改用 start:next
npm run start:next     # node dist/server/server.js（新站生产形态）

npm run build          # vite build（客户端资产）+ tsc（服务端 → dist/server）
npm run typecheck      # 三份 tsconfig：服务端 / 客户端 / 脚本与测试
npm run lint           # eslint + stylelint + prettier --check
npm test               # vitest run
npm run test:repo      # 只跑 repository 测试（CI 会在 PG/MySQL 上重跑同一套）

npm run check:inline   # 视图层不得出现内联样式 / 事件处理器
npm run check:contrast # 设计 token 对比度（WCAG 2.1 AA）
npm run check:budget   # 前端产物体积预算（需先 build:assets）

npm run db:import -- --dry-run   # 旧 JSON → 数据库，先出报告不落盘
npm run db:smoke                 # 数据层手工冒烟
npm run golden:record            # 重录 API v1 契约基线（只在故意改 API 时）
```

生产部署：`pm2 start ecosystem.config.cjs`（应用名 `subtier`，512M 内存重启阈值）。

质量门禁是**强制**的，CI 会跑全部上述检查。其中几条容易踩：
`noUncheckedIndexedAccess` 与 `noPropertyAccessFromIndexSignature`（所以
`dataset['x']`、`process.env['X']`、`req.params['id']` 必须用索引访问）；
stylelint 的 `declaration-strict-value`（CSS 里禁止字面色值/字号，必须走 token）；
ESLint 对视图层 `style=` / `on*=` / `dangerouslySetInnerHTML` 的硬禁止。

## 架构总览（新站）

Express 5 + **JSX-SSR（Preact `renderToString`，无 hydration）**，Kysely 数据层可在
SQLite / PostgreSQL / MySQL 之间运行时切换。分层：

```
app/
├─ server.ts app.ts        # 入口与装配
├─ config/                 # env（唯一读 process.env 的地方）+ constants
├─ db/                     # Kysely 类型、方言工厂、DbManager、迁移
├─ repositories/           # 行 ↔ 领域对象，唯一写 SQL 的地方
├─ services/               # 业务规则，唯一抛 AppError 的地方
├─ errors/                 # AppError + 错误码集中表
├─ web/
│  ├─ middleware/          # csrf / auth / context / rateLimits / maintenance / errorHandler
│  ├─ routes/              # 只做「鉴权 → zod → service → render」
│  ├─ views/               # BaseLayout + components + pages（TSX）
│  └─ shared/messages.ts   # 面向用户的文案字典
├─ client/                 # 渐进增强 TS（Vite 多入口）
├─ styles/                 # 设计 token + 组件 CSS（@layer）
└─ static/                 # favicon、sprite
```

### 几条不变量

**中间件顺序是 load-bearing。** `app.ts` 里公开 API 必须挂在 `csrfProtection` **之前**，
否则外部机器人的 GET 请求会被 CSRF 中间件链上，且 API 错误会落到 HTML 错误页而非 JSON 信封。

**repository 每次调用都向 DbManager 索取当前连接**（`BaseRepository` 的 `db` 是 getter），
绝不在构造时捕获。这正是运行时热切库的支点——切换只是换掉 `DbManager` 里的指针。

**`position` 不落库。** 读取时由 `utils/ranking.ts` 的 `rankEntries()` 计算：积分降序、
同分共享名次并跳号（1,1,3,4,4,6）、玩家名做稳定 tiebreak。这个顺序出现在公开 API 里，
改它就是破坏契约。

**细分项目是一等实体**（`categories` 表 + `entry_tiers` 关联表）。旧站把它定义为
所有条目 `categories` 键的并集，于是增删改都要遍历全表；现在改名是改一行，
删除靠外键级联，条目上的定级自动跟随。

**验证码以 HMAC 落库**（密钥由 `SESSION_SECRET` 经 HKDF 派生）。6 位数字空间只有 10⁶，
明文存储意味着数据库一旦只读泄露就能直接冒用。`services/verificationService.ts`
是验证码的唯一实现，`verify_email` 与 `reset_password` 共用同一套状态机。

### 错误与文案

`AppError(code, { meta })` 是唯一的业务异常类型，码表在 `errors/codes.ts`
（码 → HTTP 状态 → 中文文案）。`errorHandler` 只有两个出口：`/api/v1/*` 走
JSON 信封 `{ error, message }`；其余渲染错误页。

跨重定向的提示只走 **PRG + session flash**（`setFlash(req, kind, id)`），
文案键在 `web/shared/messages.ts`。不要再引入 `?error=code` 这类查询参数机制。

### 公开 API v1 是契约冻结区

`tests/golden/api-v1.json` 是用固定 fixture 在**旧站**上录制的 22 条真实响应快照
（状态码 + 关键响应头 + 响应体）。`tests/contract/apiV1.test.ts` 把同一份 fixture 灌进
新实现逐字段比对。外部机器人在消费这些端点，所以**测试失败意味着契约被破坏，
应当改实现而不是改基线**。

基线锁住了一些手写期望值一定会漏的细节：zod 的默认错误文案
（`Too small: expected number to be >=1`、`Invalid input: expected number, received NaN`）、
404 消息里嵌的原始路径、tier 分桶排序（HT 先于 LT，再按积分降序，再按名字升序）、
`count`/`offset` 是**每个分桶**而非全局、以及无法解析的 tier 在 `/players/:name` 里转成 `null`。

### 数据库切换

连接配置存 `data/db-config.json`（0600、原子写、gitignore），文件缺失即默认 SQLite，
因此全新部署零配置可跑。`/admin/database`（仅 SuperAdmin）提供测试连接与切换。

`services/dbSwitchService.ts` 的安全性来自一条不变量：**active 指针在全部工作成功之前
绝不移动**。顺序是「连接 → 迁移 → 校验目标 → 维护模式 → 复制 → 逐表核对 → 写配置 → 切指针 →
清会话」，任何一步失败都只需丢掉目标连接，旧库从未被写。切库后所有会话失效
（会话不跨库搬迁），面板会提示重新登录。

目标库连不上导致进程起不来时，用 `FORCE_SQLITE=1` 强制回退，或直接删除
`data/db-config.json`。

### 三级 RBAC

`SuperAdmin`（恰好一个，由 `ADMIN_USERNAME` 指定）| `Admin` | `User`。
不变量集中在 `services/userService.ts`：SuperAdmin 不可降级/删除，任何人不能对自己操作。
中间件在 `web/middleware/auth.ts`——`requireAuth` 每次都回查数据库并刷新会话快照，
因为账号可能已被删除或降级（旧站只看会话快照，已删用户的旧会话仍能通行）。

### 前端

视觉方向是「材质段位」：把 Minecraft 的材质进阶（石→铁→铜→金→钻石→绿宝石→下界合金）
翻译成 7 档段位徽章色阶，配分段式 XP 槽与像素 SVG 图标。签名元素限量，其余扁平安静。
段位匹配刻意宽容（忽略大小写/空格/`Subtier` 前缀），认不出的退回石质档而不是消失。

榜单用 `<ol>` + CSS Grid，桌面与移动**共用一份标记**（靠 `grid-template-areas` 重排），
不再需要旧站的 `data-label` 双维护。排序与搜索都是服务端行为（URL 参数），
客户端脚本只做增强，禁用 JS 后功能完整。

`<Form>` 组件自动注入 CSRF 隐藏域——旧站 22 个表单各自手抄一遍，漏写就是运行时 403。

CSP 已收紧到 `style-src 'self'`（零内联样式，动态值走属性如 `<progress value max>`）。
`npm run check:inline` 与 `tests/integration/accessibility.test.ts` 会持续守住这条。

## 环境变量

`.env.example` 是权威列表。几个容易出错的：

- **`SESSION_SECRET`**：生产环境**必须**设置，缺失直接启动失败（旧站是静默用随机值）。
  它同时用于会话签名与验证码 HMAC 派生。
- `APP_BASE_URL`：拼装 Microsoft OAuth 的 `redirect_uri`，必须与 Azure 应用注册里登记的完全一致。
- `EMAIL_FROM`：必须是 RFC 5322 形式且域名已在 Resend 验证，否则 4xx。
- `MS_OAUTH_CLIENT_SECRET`：只从环境变量读，不入库、不在后台表单出现。
- `DATA_DIR`：数据目录，默认 `<cwd>/data`。旧站也支持（用于隔离测试）。
- `FORCE_SQLITE=1`：忽略 `db-config.json` 强制用 SQLite，救急用。

Resend 与 Microsoft OAuth 都是**手写 fetch，不引 SDK**——两个集成各只用到一两个端点，
SDK 的收益不抵依赖成本。这个取舍从旧站延续，请勿引入 `resend`、`passport` 等。

## 上线切换清单

新站已通过全部门禁与生产形态冒烟，但**尚未接管流量**。切换需要人工决定时机，步骤：

1. **确认服务器 Node ≥ 22**，且 `.env` 里有 `SESSION_SECRET`（新站缺失会拒绝启动）。
2. 停旧站，**备份 `data/*.json`**。
3. `npm run db:import -- --dry-run` 看报告，确认用户/条目/定级数量与排名前 10 名一致。
   有「只差大小写的重复账号」时会中止并列出，需人工处理后重跑。
4. `npm run db:import` 正式导入（幂等，可重跑）。
5. `npm run build`。
6. 把 `ecosystem.config.cjs` 的 `script` 改为 `dist/server/server.js`，
   `package.json` 的 `start` 改为 `node dist/server/server.js`。
7. `pm2 restart subtier`，跑冒烟：首页、`/api/docs`、四个 API 端点、登录、后台。
8. 观察外部机器人对 `/api/v1/*` 的调用 48 小时。
9. 稳定后再删除 `src/`、`views/`、`public/`、`src/package.json`，
   并从依赖里移除 `csurf`、`exceljs`、`ejs`、`nodemon`。

导入**建议在启动新站之前**做：新站启动时会 seed 一个 `admin` 账号，之后导入同名/同邮箱的
旧账号会走「合并」路径（保留已有 id、更新其余字段）。顺序颠倒不会失败，但报告里会出现
「与已有账号合并」，属正常。
