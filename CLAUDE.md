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

**upsert 的语法三方言不通用。** Kysely 的 `onConflict()` 是 PostgreSQL / SQLite 的写法，
`MysqlQueryCompiler` **不会**把它翻译成 MySQL 的形式——它照原样输出
`on conflict (...) do update set ...`，MySQL 报 `ER_PARSE_ERROR`。所有 upsert 必须走
`db/upsert.ts` 的 `upsertRow()`（repository 里用 `this.driver`，`legacyImport` 由调用方传入）。
这个坑很安静：默认的 SQLite 与 PostgreSQL 都正常，只有 MySQL 会炸，炸的是会话写入、
设置保存与验证码签发——登录、后台保存、注册三条主路径。`tests/unit/upsert.test.ts`
用 `DummyDriver` 只编译 SQL 不连库，是这条约束的本地守卫；别把 CI 的 MySQL 矩阵当第一道防线。

**`position` 不落库。** 读取时由 `utils/ranking.ts` 的 `rankEntries()` 计算：积分降序、
同分共享名次并跳号（1,1,3,4,4,6）、玩家名做稳定 tiebreak。这个顺序出现在公开 API 里，
改它就是破坏契约。

**细分项目是一等实体**（`categories` 表 + `entry_tiers` 关联表）。旧站把它定义为
所有条目 `categories` 键的并集，于是增删改都要遍历全表；现在改名是改一行，
删除靠外键级联，条目上的定级自动跟随。

**列宽只有 PostgreSQL / MySQL 会强制，所以长度必须在服务端卡住。** SQLite 根本不看
`varchar(n)`，MySQL 视 `sql_mode` 报错或静默截断，只有 PostgreSQL 一定报错。于是超长值的
典型命运是：先安静地进 SQLite，等到日后走面板 `migrate` 时才在复制事务里炸，而那时错误
来自驱动层，既指不出行也指不出列。凡是写进这几列的路径都必须自带长度校验——
表单侧是 `utils/validation.ts`（`entrySchema` 各字段 + `parseTierPayload` 的
`FIELD_LIMITS.tier`，视图上的 `maxlength` 只是客户端属性，不算数），
旧数据侧是 `scripts/lib/legacyImport.ts` 的 `findOversized()`，它在导入**之前**跑并让
`db:import` 直接失败。`COLUMN_LIMITS` 与 `db/migrations/001_init.ts` 必须手动保持同步。

**验证码以 HMAC 落库**（密钥由 `SESSION_SECRET` 经 HKDF 派生）。6 位数字空间只有 10⁶，
明文存储意味着数据库一旦只读泄露就能直接冒用。`services/verificationService.ts`
是验证码的唯一实现，`verify_email` 与 `reset_password` 共用同一套状态机。

**CSRF 令牌是惰性铸造的。** `csrfProtection` 对 GET/HEAD/OPTIONS 什么都不做，令牌只在
视图真的读 `ctx.csrfToken`（即页面上有 POST 表单）时才写进会话。原因是写放大：往会话上
写任何东西都会让 `saveUninitialized: false` 失效，于是每次匿名 GET——包括 404——都落一行
`sessions` 并下发 `Set-Cookie`，机器人每命中一个公开页就是一次 INSERT，且所有 HTML
响应都不再可能被共享缓存复用。因此**不要在中间件里无条件调用 `currentCsrfToken()`**。
推论：会话里没有令牌的 POST 一律 403（`tests/integration/authRoutes.test.ts` 守着这条）。

**防账号枚举**要同时守住三个维度：状态码、正文、**耗时**。登录失败一律
「账号或密码错误」；`/forgot` 与 `/resend-verification` 无论邮箱存不存在都走同一条
PRG（Location 里回显的是提交者自己给的邮箱，不构成信道）。三个容易破的点：

- 「账号不存在」分支里的占位 bcrypt 哈希**必须合法**（60 字符）。bcryptjs 对长度不符的
  串直接返回 false 而不做任何计算，一个形似的假串会让 200ms 的时间差直接暴露账号是否
  存在。占位哈希由 `authService.placeholderPasswordHash(cost)` 惰性生成并按 cost 缓存。
- **发信绝不能 await。** 不存在的邮箱在 service 里直接 return（毫秒级），存在的要等一次
  Resend 往返（约 1.2 秒）。await 就等于把枚举信道搬到响应耗时上，而且比状态码信道更
  好用：一个请求判定一个邮箱，不需要 cookie、不需要连发两次。两条路由都走
  `dispatchMail()`，它负责 fire-and-forget **并把失败记进日志**——吞掉异常而不记日志
  就是 `errorHandler` 注释里点名批判的那种静默降级。
- 账号级冷却（`verification_codes.last_sent_at`）只会对**真实存在**的账号触发，因此
  `cooldown_active` 绝不能渲染给用户。发信页的冷却提示走会话级的 `session.mailCooldown`
  （连提交的邮箱一起记，好让打错地址的人改正后不必干等）——它只取决于你自己刚填了
  什么，所以不构成信道。相应地，这两条路径的成功文案必须是
  `auth.codeSentIfRegistered`（「若该邮箱已注册…」）而不是断定式的「已发送」。

**`code_expired` / `code_invalid` / `code_locked` 三条文案必须一模一样**，
且页面上**不展示剩余尝试次数**。它们区分的是「这个邮箱没有账号 / 有账号但码过期 /
有账号且码错了」——文案一旦不同，拿个乱填的验证码打一次 `POST /verify` 就能读出
邮箱是否注册过，确定性、无需计时，比 `/forgot` 那条还好用。剩余次数只对真实存在的
账号才有意义，展示它就是判据。次数仍留在 `AppError` 的 meta 里，可用于日志。

### 错误与文案

`AppError(code, { meta })` 是唯一的业务异常类型，码表在 `errors/codes.ts`
（码 → HTTP 状态 → 中文文案）。`errorHandler` 有两个出口：`/api/v1/*` 走 JSON 信封
`{ error, message }`；其余渲染错误页。

`apiV1Router` 末尾还有**第三个**出口，它只服务 `/api/v1/*` 且刻意与上面两个不同：
一律 `500 { error: 'internal_error', message: 'unexpected server error' }`，**不**沿用
AppError 的 code 与 status。理由是对外承诺的错误码只有 5 个（见 `ApiDocs` 与 README），
沿用内部码会把 `errors/codes.ts` 那张 44 条的表接到匿名端点上（`db_target_not_empty`、
`cannot_modify_super` 之类），还会产出 `404 + "unexpected server error"` 这种自相矛盾的
信封。注意路径匹配的缝隙：`/api/v1foo`、`/api/v1.json` 这类**不会**进 apiV1Router，
会落到 app 级 `errorHandler`，因而拿到中文文案且没有 CORS 头。

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
绝不移动**。切指针**之前**的顺序是「连接 → 迁移 → 校验目标 → 维护模式 → 复制 → 逐表核对 →
写配置」，其中任何一步失败都只需丢掉目标连接，旧库从未被写。切指针之后还有两步收尾
（清会话、保障 SuperAdmin），它们会写**目标**库，所以不在「可丢弃」的范围内。切库后所有
会话失效（会话不跨库搬迁），面板会提示重新登录。

收尾里的 SuperAdmin 保障是必须的：切库会清空全部会话，而 `direct` 模式只校验结构版本、
完全不看有没有用户——切到一个「已迁移但空」的库就再没人能登回来了。但它**只在目标库
完全没有 SuperAdmin 时才动手**，绝不无条件调用 `ensureSuperAdmin()`：那个函数不止
「缺则补」一件事，它还会把 `ADMIN_USERNAME` 同名的既有账号提升为 SuperAdmin，于是
「切一次库」会顺带变成「给目标库里那个叫 admin 的普通用户提权」，并且每切一次就把
`ADMIN_PASSWORD` 重新变成一条可用凭据。它排在切指针**之后**且只记日志不抛：此刻切换
已经成功，为一次 seed 失败把它报成失败会破坏上面那条不变量。

**切库的失败路径必须自己记日志。** `/admin/database/switch` 把 `AppError` 就地转成 flash
再重定向，所以那条错误根本走不到 `errorHandler` 的 `status >= 500` 分支——不在
`dbSwitchService` 里记，操作者能拿到的全部信息就是码表里那句「数据搬迁失败，已保持使用
原数据库」，而真正有用的是被包在 `cause` 里的驱动层报错（列宽溢出、权限不足、证书校验
失败……）。`failWithLog()` 负责这件事，日志前缀是 `[db-switch]`。这是切库这条路上唯一的
取证渠道，别把它简化掉。

TLS 默认**校验证书**。自签证书、私有 CA 或按 IP 连接（证书几乎不带 IP SAN）时才需要在
面板上勾「跳过证书校验」（配置字段 `sslInsecure`）——只加密不认证挡不住中间人，所以它
必须是显式选择，且会在 `describeConnection()` 的摘要里标出来，免得勾上之后再没人记得。
`tests/unit/dialects.test.ts` 守住这个默认值（那两条分支在集成测试里从不真的建连）。

目标库连不上导致进程起不来时，用 `FORCE_SQLITE=1` 强制回退，或直接删除
`data/db-config.json`。若是证书校验失败（`SELF_SIGNED_CERT_IN_CHAIN` 等），手动在
`data/db-config.json` 里加 `"sslInsecure": true` 即可——注意这两条救急路径中，前者会落到
一个空的 SQLite 文件上，别误判成数据丢了。

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

- **`SESSION_SECRET`**：生产环境**必须**设置且**至少 32 个字符**，缺失或过短都直接启动失败
  （旧站是静默用随机值）。它同时用于会话签名与验证码 HMAC 派生，两件事共用同一份密钥材料，
  所以短口令等于两条防线一起被削弱。生成：
  `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`。
- **`APP_BASE_URL`**：生产环境**同样必须**设置，缺失直接启动失败。它不只是拼 Microsoft
  OAuth 的 `redirect_uri`（必须与 Azure 应用注册里登记的完全一致）——`isHttps` 也从它推导，
  一旦退回 `http://localhost:PORT`，会话 cookie 会静默丢掉 `Secure`、CSP 会丢掉
  `upgrade-insecure-requests`。三件事都不报错，所以按 `SESSION_SECRET` 的先例拒绝启动。
- `EMAIL_FROM`：必须是 RFC 5322 形式且域名已在 Resend 验证，否则 4xx。
- `MS_OAUTH_CLIENT_SECRET`：只从环境变量读，不入库、不在后台表单出现。
- `DATA_DIR`：数据目录，默认 `<cwd>/data`。旧站也支持（用于隔离测试）。
- `FORCE_SQLITE=1`：忽略 `db-config.json` 强制用 SQLite，救急用。

Resend 与 Microsoft OAuth 都是**手写 fetch，不引 SDK**——两个集成各只用到一两个端点，
SDK 的收益不抵依赖成本。这个取舍从旧站延续，请勿引入 `resend`、`passport` 等。

## 上线切换清单

新站已通过全部门禁与生产形态冒烟，但**尚未接管流量**。切换需要人工决定时机，步骤：

1. **确认服务器 Node ≥ 22**，且 `.env` 里有 `SESSION_SECRET`（≥ 32 字符）**与 `APP_BASE_URL`**
   （缺任一或密钥过短都会拒绝启动）。
2. 停旧站，**备份 `data/*.json`**。
3. `npm run db:import -- --dry-run` 看报告，确认用户/条目/定级数量与排名前 10 名一致。
   有「只差大小写的重复账号」时会中止并列出，需人工处理后重跑。
   **超出列宽的字段同样会中止**并逐条列出（哪条记录、哪个字段、多少字符）——这条检查
   是给 PostgreSQL / MySQL 用的：本脚本的目标固定是 SQLite，而 SQLite 不强制 `varchar(n)`，
   放行的话报告一片绿，直到日后用面板迁移到服务型数据库时才炸。
   **同时核对报告最后一行的 SuperAdmin 清单**：旧站把 `role === 'admin'` 也算 SuperAdmin，
   导入会忠实沿用这条规则，于是旧数据里有几个这样的账号就会有几个 SuperAdmin。而新站
   不允许对 SuperAdmin 降级或删除，多出来的那些在后台里动不了——若不是预期结果，
   先改旧数据里的 `role` 再重跑。
4. `npm run db:import` 正式导入（幂等，可重跑）。
5. `npm run build`。
6. 把 `ecosystem.config.cjs` 的 `script` 改为 `dist/server/server.js`，
   `package.json` 的 `start` 改为 `node dist/server/server.js`，
   并给 PM2 加上 `env: { NODE_ENV: 'production' }`。

   **`NODE_ENV=production` 这一项不能漏**：`SESSION_SECRET` 与 `APP_BASE_URL` 的强制
   校验、会话 cookie 的 `Secure`、CSP 的 `upgrade-insecure-requests` 全都挂在它上面。
   仓库里目前没有任何地方设它（`.env.example` 是 `development`，PM2 配置没有 `env` 块，
   CI 也不设），所以不显式加的话上面那些保护**一条都不会生效**，而且不会有任何报错。
   启动日志会打出 `（NODE_ENV=…）`，用它确认。

   **不要顺手加 `instances`**：进程内状态（维护标志、设置缓存、限流计数、DbManager 的
   连接指针）都是每 worker 一份，cluster 模式下一次切库只会移动其中一个 worker 的指针。

7. `pm2 restart subtier`，跑冒烟：首页、`/api/docs`、四个 API 端点、登录、后台。
8. 观察外部机器人对 `/api/v1/*` 的调用 48 小时。
9. 稳定后再删除 `src/`、`views/`、`public/`、`src/package.json`，
   并从依赖里移除 `csurf`、`exceljs`、`ejs`、`nodemon`。

导入**建议在启动新站之前**做：新站启动时会 seed 一个 `admin` 账号，之后导入同名/同邮箱的
旧账号会走「合并」路径（保留已有 id、更新其余字段）。顺序颠倒不会失败，但报告里会出现
「与已有账号合并」，属正常。
