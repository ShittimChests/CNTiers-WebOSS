import { Router, type NextFunction, type Request, type Response } from 'express';
import { API_CACHE_SECONDS, API_LIMITS } from '../../config/constants.js';
import { categoryRepository } from '../../repositories/categoryRepository.js';
import { leaderboardService } from '../../services/leaderboardService.js';
import type { RankedEntry } from '../../types/domain.js';
import { parseTier } from '../../utils/tier.js';
import {
  apiGamemodeNameSchema,
  apiListPaginationSchema,
  apiPlayerNameSchema,
  apiTierPaginationSchema
} from '../../utils/validation.js';

/**
 * 公开只读 API v1 —— 契约冻结区。
 *
 * 外部机器人正在消费这些端点，响应形状、错误信封、状态码与响应头都不可改动。
 * 基线快照在 tests/golden/api-v1.json，任何改动必须先过
 * tests/contract/apiV1.test.ts；让测试适配代码是错的方向。
 *
 * 挂载顺序也是契约的一部分：本路由必须在 csrfProtection **之前** 挂到 app 上，
 * 否则 CSRF 中间件会链上这些 GET 请求，且错误会落到 HTML 错误页而非 JSON。
 */
export const apiV1Router = Router();

apiV1Router.use((_req, res, next) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  next();
});

/** 成功响应统一带 60 秒公共缓存。 */
function sendCached(res: Response, body: unknown): void {
  res.setHeader('Cache-Control', `public, max-age=${String(API_CACHE_SECONDS)}`);
  res.json(body);
}

function invalidQuery(res: Response, message: string): void {
  res.status(400).json({ error: 'invalid_query', message });
}

/** 对外的玩家投影。字段集是契约，不要顺手加字段。 */
interface CompactPlayer {
  name: string;
  points: number;
  rank: string;
  position: number;
}

function compactPlayer(entry: RankedEntry): CompactPlayer {
  return {
    name: entry.player,
    points: entry.points,
    rank: entry.rank,
    position: entry.position
  };
}

// ---------- GET /gamemodes ----------

apiV1Router.get('/gamemodes', (_req, res, next) => {
  void (async () => {
    try {
      sendCached(res, { gamemodes: await categoryRepository.listNames() });
    } catch (error) {
      next(error);
    }
  })();
});

// ---------- GET /rankings ----------

apiV1Router.get('/rankings', (req, res, next) => {
  void (async () => {
    try {
      const parsed = apiListPaginationSchema.safeParse(req.query);
      if (!parsed.success) {
        invalidQuery(res, parsed.error.issues[0]?.message ?? 'invalid query');
        return;
      }

      const { limit, offset } = parsed.data;
      // listRanked 的输出已按名次升序，与旧实现「读文件后按 position 排」等价
      const ranked = await leaderboardService.listRanked();

      sendCached(res, {
        total: ranked.length,
        limit,
        offset,
        players: ranked.slice(offset, offset + limit).map(compactPlayer)
      });
    } catch (error) {
      next(error);
    }
  })();
});

// ---------- GET /rankings/:gamemode ----------

interface BucketRow extends CompactPlayer {
  tier: string;
}

apiV1Router.get('/rankings/:gamemode', (req, res, next) => {
  void (async () => {
    try {
      const nameParse = apiGamemodeNameSchema.safeParse(req.params.gamemode);
      const queryParse = apiTierPaginationSchema.safeParse(req.query);
      if (!nameParse.success || !queryParse.success) {
        // 与旧实现一致：名字错误优先于分页参数错误
        const issue = nameParse.success
          ? queryParse.error?.issues[0]?.message
          : nameParse.error.issues[0]?.message;
        invalidQuery(res, issue ?? 'invalid query');
        return;
      }

      const requested = nameParse.data;
      const { count, offset } = queryParse.data;

      // 大小写不敏感查找，但响应里回的是规范大小写
      const category = await categoryRepository.findByName(requested);
      if (!category) {
        res
          .status(404)
          .json({ error: 'gamemode_not_found', message: `gamemode '${requested}' does not exist` });
        return;
      }

      const ranked = await leaderboardService.listRanked();
      const buckets = new Map<string, (BucketRow & { half: 'HT' | 'LT' })[]>();
      for (let major = 1; major <= API_LIMITS.tierBuckets; major += 1) {
        buckets.set(String(major), []);
      }

      for (const entry of ranked) {
        const raw = entry.tiers[category.name];
        if (raw === undefined) continue;

        const tier = parseTier(raw);
        if (!tier) {
          // 历史数据里确实存在无法解析的值。跳过而不是报错，与旧实现一致
          console.warn(
            `[api] unparseable tier "${raw}" on player "${entry.player}" in gamemode "${category.name}"`
          );
          continue;
        }

        buckets.get(String(tier.major))?.push({
          ...compactPlayer(entry),
          tier: tier.canonical,
          half: tier.half
        });
      }

      const tiers: Record<string, BucketRow[]> = {};
      for (const [major, rows] of buckets) {
        rows.sort((a, b) => {
          if (a.half !== b.half) return a.half === 'HT' ? -1 : 1;
          if (b.points !== a.points) return b.points - a.points;
          return a.name.localeCompare(b.name);
        });
        // offset 与 count 都是"每个分桶"的，不是全局的
        tiers[major] = rows.slice(offset, offset + count).map(({ half: _half, ...rest }) => rest);
      }

      sendCached(res, { gamemode: category.name, count, offset, tiers });
    } catch (error) {
      next(error);
    }
  })();
});

// ---------- GET /players/:name ----------

apiV1Router.get('/players/:name', (req, res, next) => {
  void (async () => {
    try {
      const nameParse = apiPlayerNameSchema.safeParse(req.params.name);
      if (!nameParse.success) {
        invalidQuery(res, nameParse.error.issues[0]?.message ?? 'invalid query');
        return;
      }

      const wanted = nameParse.data.toLowerCase();
      const [ranked, gamemodes] = await Promise.all([
        leaderboardService.listRanked(),
        categoryRepository.listNames()
      ]);

      const entry = ranked.find((item) => item.player.toLowerCase() === wanted);
      if (!entry) {
        res
          .status(404)
          .json({ error: 'not_found', message: `player '${nameParse.data}' not found` });
        return;
      }

      // 契约要求列出**每一个**已知项目，未定级为 null
      const categories: Record<string, string | null> = {};
      for (const gamemode of gamemodes) {
        const raw = entry.tiers[gamemode];
        if (raw === undefined) {
          categories[gamemode] = null;
          continue;
        }

        const tier = parseTier(raw);
        if (!tier) {
          console.warn('[api] invalid tier value for player category', {
            player: entry.player,
            gamemode,
            value: raw
          });
          categories[gamemode] = null;
          continue;
        }
        categories[gamemode] = tier.canonical;
      }

      sendCached(res, { ...compactPlayer(entry), categories });
    } catch (error) {
      next(error);
    }
  })();
});

// ---------- 兜底 ----------

apiV1Router.use((req, res) => {
  res.status(404).json({
    error: 'not_found',
    message: `route '${req.method} ${req.originalUrl}' does not exist`
  });
});

/**
 * API 自己的错误出口，绝不让错误落到 HTML 错误页。
 *
 * 刻意**不**沿用 AppError 的状态码与码名。曾经改成那样，理由是「502 的数据库
 * 故障不该表现成 500」，但那个理由是虚构的：`/api/v1` 的整条调用图里没有任何
 * AppError 会到达这里（Kysely 与 repository 抛的是普通 Error，db_connect_failed
 * 只在 /admin/database 的路径上抛）。换来的代价却是真的——`error` 字段会从
 * errors/codes.ts 那张 44 条内部码表里取值，于是匿名公开端点可能吐出
 * `db_target_not_empty`、`cannot_modify_super` 这类内部管理词汇，还会产生
 * `404 + "unexpected server error"` 这种自相矛盾的信封，以及不带 Retry-After
 * 的 429。ApiDocs 与 README 对外承诺的错误码只有 5 个，这里必须收在里面。
 *
 * 唯一的实质改动是补上 headersSent 卫兵（app 级 errorHandler 早就有）：
 * 响应已经开始发送时二次写入会抛 ERR_HTTP_HEADERS_SENT 并逃出 handler。
 */
apiV1Router.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
  console.error('[api]', error);
  if (res.headersSent) {
    next(error);
    return;
  }
  res.status(500).json({ error: 'internal_error', message: 'unexpected server error' });
});
