import { Router } from 'express';
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
 * baseUrl 用请求自身的 host 拼装，这样示例里的 curl 可以直接复制运行
 * （无论站点跑在本机、隧道域名还是别的端口上）。
 */
publicRouter.get('/api/docs', (req, res) => {
  const baseUrl = `${req.protocol}://${req.get('host') ?? 'localhost'}`;
  renderPage(res, ApiDocsPage({ ctx: viewContext(res), baseUrl }));
});
