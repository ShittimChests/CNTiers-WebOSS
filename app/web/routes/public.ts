import { Router } from 'express';
import { config } from '../../config/env.js';
import { categoryService } from '../../services/categoryService.js';
import { leaderboardService } from '../../services/leaderboardService.js';
import { boardQuerySchema } from '../../utils/validation.js';
import { viewContext } from '../middleware/context.js';
import { renderPage } from '../views/lib/render.js';
import { ApiDocsPage } from '../views/pages/ApiDocs.js';
import { HomePage } from '../views/pages/Home.js';

export const publicRouter = Router();

/**
 * 榜单首页。
 *
 * 排序与搜索都是服务端行为（URL 参数），客户端脚本只做增强，
 * 因此禁用 JS 后页面功能完整。非法参数由 schema 的 catch 退回默认值，
 * 而不是报错——URL 是用户可以随手编辑的。
 */
publicRouter.get('/', (req, res, next) => {
  void (async () => {
    try {
      const { sort, dir, q } = boardQuerySchema.parse(req.query);

      const [board, categories] = await Promise.all([
        leaderboardService.listForBoard({ sort, dir, query: q }),
        categoryService.listNames()
      ]);

      renderPage(
        res,
        HomePage({
          ctx: viewContext(res),
          entries: board.entries,
          playerCount: board.total,
          categoryCount: categories.length,
          maxPoints: board.maxPoints,
          sort,
          dir,
          query: q
        })
      );
    } catch (error) {
      next(error);
    }
  })();
});

/**
 * 公开 API 的文档页。
 *
 * baseUrl 取 config.appBaseUrl（生产环境必填，开发环境退回 http://localhost:PORT），
 * 而不是 `req.get('host')`。示例里的 curl 照样能直接复制运行，但页面内容不再
 * 随请求头变化——Host 是客户端可控的，让它决定文档里印出来的域名，等于给了
 * 任何人一个「让本站页面展示他指定地址」的原语。这也与 OAuth 的 redirect_uri
 * 用同一个事实来源，两处不会漂移。
 */
publicRouter.get('/api/docs', (_req, res) => {
  renderPage(res, ApiDocsPage({ ctx: viewContext(res), baseUrl: config.appBaseUrl }));
});
