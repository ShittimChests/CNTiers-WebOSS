import compression from 'compression';
import express, { type Express } from 'express';
import session from 'express-session';
import helmet from 'helmet';
import { BODY_LIMIT, SESSION_COOKIE_NAME, SESSION_TTL_MS } from './config/constants.js';
import { config } from './config/env.js';
import { ASSET_DIR } from './web/views/lib/assets.js';
import { attachContext } from './web/middleware/context.js';
import { csrfProtection } from './web/middleware/csrf.js';
import { errorHandler, notFoundHandler } from './web/middleware/errorHandler.js';
import { blockWritesDuringMaintenance } from './web/middleware/maintenance.js';
import { apiCors, apiLimiter } from './web/middleware/rateLimits.js';
import { KyselySessionStore } from './web/session/KyselySessionStore.js';
import { accountRouter } from './web/routes/account.js';
import { adminRouter } from './web/routes/admin.js';
import { adminDatabaseRouter } from './web/routes/adminDatabase.js';
import { apiV1Router } from './web/routes/apiV1.js';
import { authRouter } from './web/routes/auth.js';
import { oauthRouter } from './web/routes/oauth.js';
import { publicRouter } from './web/routes/public.js';
import { styleguideRouter } from './web/routes/styleguide.js';

/**
 * 组装 Express 应用。与监听分离，便于测试直接拿到 app 实例。
 *
 * 中间件顺序里有一条硬约束：公开 API 必须挂在 csrfProtection **之前**。
 * 否则外部机器人的 GET 请求会被 CSRF 中间件链上，并且 API 的错误会落到
 * HTML 错误页而不是 JSON 信封。这条约束从旧站延续下来。
 */
export function createApp(): Express {
  const app = express();

  // Cloudflare Tunnel 恰好一跳。旧站用的是 `true`，那会让任何人都能
  // 伪造 X-Forwarded-For 从而绕过按 IP 的限流
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(compression());

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          // 视图层零内联样式，因此不需要 unsafe-inline
          styleSrc: ["'self'"],
          imgSrc: ["'self'"],
          fontSrc: ["'self'"],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          frameAncestors: ["'none'"],
          formAction: ["'self'"],
          upgradeInsecureRequests: config.isHttps ? [] : null
        }
      },
      // 资源是同源的，隔离策略保持 helmet 默认
      crossOriginEmbedderPolicy: false
    })
  );

  // 带 hash 的产物可以长期缓存；其余（favicon、sprite）走协商缓存
  app.use(
    '/assets',
    express.static(`${ASSET_DIR}/assets`, {
      immutable: true,
      maxAge: '1y'
    })
  );
  app.use(express.static(ASSET_DIR, { maxAge: '1h' }));

  app.use(express.urlencoded({ extended: false, limit: BODY_LIMIT }));
  app.use(express.json({ limit: BODY_LIMIT }));

  app.use(
    session({
      name: SESSION_COOKIE_NAME,
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      store: new KyselySessionStore(),
      cookie: {
        httpOnly: true,
        secure: config.isHttps,
        sameSite: 'lax',
        maxAge: SESSION_TTL_MS
      }
    })
  );

  // ---- 公开 API：必须早于 csrfProtection ----
  // 否则 CSRF 中间件会链上外部机器人的 GET 请求，
  // 且 API 错误会绕过 apiV1Router 自己的 5 码出口，
  // 从 errorHandler 拿到内部码的中文信封
  app.use('/api/v1', apiCors, apiLimiter, apiV1Router);

  app.use(csrfProtection);
  app.use(attachContext);
  // 切库期间挡住写请求：读继续走旧库，写返回 503
  app.use(blockWritesDuringMaintenance);

  // ---- 页面路由 ----
  app.use(publicRouter);
  app.use(authRouter);
  app.use(oauthRouter);
  app.use(accountRouter);
  app.use(adminRouter);
  app.use(adminDatabaseRouter);

  if (!config.isProduction) {
    // 组件库总览。开发态专用：既是设计系统的可视检查点，
    // 也让孤儿样式一眼可见
    app.use('/styleguide', styleguideRouter);
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
