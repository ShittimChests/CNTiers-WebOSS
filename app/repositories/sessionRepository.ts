import { upsertRow } from '../db/upsert.js';
import { BaseRepository } from './base.js';

export interface StoredSession {
  sid: string;
  userId: string | null;
  data: string;
  expiresAt: string;
}

/**
 * 会话存储。取代旧的 data/sessions.json（每次 set/touch 重写整个文件）。
 *
 * 相比旧实现多了 user_id 列：删除用户时可以精确清掉其全部会话，
 * 修复「已删除用户的旧会话仍能通过 requireAuth」这个缺陷。
 */
export class SessionRepository extends BaseRepository {
  async get(sid: string): Promise<StoredSession | null> {
    const row = await this.db
      .selectFrom('sessions')
      .selectAll()
      .where('sid', '=', sid)
      .executeTakeFirst();
    if (!row) return null;
    return { sid: row.sid, userId: row.user_id, data: row.data, expiresAt: row.expires_at };
  }

  async set(session: StoredSession): Promise<void> {
    await upsertRow(
      this.db.insertInto('sessions').values({
        sid: session.sid,
        user_id: session.userId,
        data: session.data,
        expires_at: session.expiresAt
      }),
      this.driver,
      ['sid'],
      {
        user_id: session.userId,
        data: session.data,
        expires_at: session.expiresAt
      }
    ).execute();
  }

  /** touch 只续期，不重写 data，省下一次大字段写入。 */
  async touch(sid: string, expiresAt: string): Promise<void> {
    await this.db
      .updateTable('sessions')
      .set({ expires_at: expiresAt })
      .where('sid', '=', sid)
      .execute();
  }

  async destroy(sid: string): Promise<void> {
    await this.db.deleteFrom('sessions').where('sid', '=', sid).execute();
  }

  async deleteByUser(userId: string): Promise<number> {
    const result = await this.db
      .deleteFrom('sessions')
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return Number(result.numDeletedRows ?? 0);
  }

  /**
   * 清掉某用户除指定会话之外的全部会话。
   *
   * 改密码要的正是这个语义：踢掉别处的登录，留住正在操作的这一个。
   * 用「删光再靠后续写操作把当前会话复活」是不可靠的——express-session 在
   * resave:false 下按加载时的哈希判断是否回写，赋一个相同的值不会触发保存。
   */
  async deleteByUserExcept(userId: string, exceptSid: string): Promise<number> {
    const result = await this.db
      .deleteFrom('sessions')
      .where('user_id', '=', userId)
      .where('sid', '!=', exceptSid)
      .executeTakeFirst();
    return Number(result.numDeletedRows ?? 0);
  }

  async deleteExpired(nowIsoString: string): Promise<number> {
    const result = await this.db
      .deleteFrom('sessions')
      .where('expires_at', '<', nowIsoString)
      .executeTakeFirst();
    return Number(result.numDeletedRows ?? 0);
  }

  async clear(): Promise<void> {
    await this.db.deleteFrom('sessions').execute();
  }

  async count(): Promise<number> {
    const row = await this.db
      .selectFrom('sessions')
      .select((eb) => eb.fn.countAll<string | number>().as('total'))
      .executeTakeFirstOrThrow();
    return Number(row.total);
  }
}

export const sessionRepository = new SessionRepository();
