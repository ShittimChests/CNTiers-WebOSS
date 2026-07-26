import { Store, type SessionData } from 'express-session';
import { SESSION_TTL_MS } from '../../config/constants.js';
import { sessionRepository, type SessionRepository } from '../../repositories/sessionRepository.js';

type Callback = (error?: unknown) => void;
type GetCallback = (error: unknown, session?: SessionData | null) => void;

/**
 * 把会话存进数据库，取代旧站的 data/sessions.json。
 *
 * 旧实现每次 set/touch 都要重写整个 JSON 文件，并且自带一套与 dataStore
 * 重复的写队列与 tempfile+rename 逻辑。这里只是普通的行读写。
 *
 * 额外记录 user_id：删除用户时可以精确清掉其全部会话，
 * 修复「已删除用户的旧会话仍能通过 requireAuth」这个缺陷。
 */
export class KyselySessionStore extends Store {
  #lastSweep = 0;
  readonly #sweepIntervalMs = 5 * 60 * 1000;

  constructor(private readonly sessions: SessionRepository = sessionRepository) {
    super();
  }

  override get(sid: string, callback: GetCallback): void {
    void (async () => {
      try {
        const stored = await this.sessions.get(sid);
        if (!stored) return callback(null, null);

        // 过期会话视为不存在，并顺手清掉
        if (Date.parse(stored.expiresAt) <= Date.now()) {
          await this.sessions.destroy(sid);
          return callback(null, null);
        }

        callback(null, JSON.parse(stored.data) as SessionData);
      } catch (error) {
        callback(error);
      }
    })();
  }

  override set(sid: string, session: SessionData, callback?: Callback): void {
    void (async () => {
      try {
        await this.sessions.set({
          sid,
          userId: extractUserId(session),
          data: JSON.stringify(session),
          expiresAt: expiryOf(session)
        });
        await this.#maybeSweep();
        callback?.();
      } catch (error) {
        callback?.(error);
      }
    })();
  }

  /** 只续期，不重写 data——省下一次大字段写入。 */
  override touch(sid: string, session: SessionData, callback?: Callback): void {
    void (async () => {
      try {
        await this.sessions.touch(sid, expiryOf(session));
        callback?.();
      } catch (error) {
        callback?.(error);
      }
    })();
  }

  override destroy(sid: string, callback?: Callback): void {
    void (async () => {
      try {
        await this.sessions.destroy(sid);
        callback?.();
      } catch (error) {
        callback?.(error);
      }
    })();
  }

  /** 惰性清扫：写入时顺带做，不额外挂定时器。 */
  async #maybeSweep(): Promise<void> {
    const now = Date.now();
    if (now - this.#lastSweep < this.#sweepIntervalMs) return;
    this.#lastSweep = now;
    const removed = await this.sessions.deleteExpired(new Date(now).toISOString());
    if (removed > 0) console.info(`已清理 ${String(removed)} 个过期会话。`);
  }
}

function expiryOf(session: SessionData): string {
  const cookieExpiry = session.cookie?.expires;
  if (cookieExpiry) return new Date(cookieExpiry).toISOString();
  return new Date(Date.now() + SESSION_TTL_MS).toISOString();
}

function extractUserId(session: SessionData): string | null {
  const user = session.user;
  return user ? user.id : null;
}
