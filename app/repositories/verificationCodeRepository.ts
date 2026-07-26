import type { VerificationPurpose } from '../config/constants.js';
import type { VerificationCodeRow } from '../db/types.js';
import { upsertRow } from '../db/upsert.js';
import type { VerificationCode } from '../types/domain.js';
import { BaseRepository } from './base.js';

function toCode(row: VerificationCodeRow): VerificationCode {
  return {
    userId: row.user_id,
    purpose: row.purpose as VerificationPurpose,
    codeHash: row.code_hash,
    expiresAt: row.expires_at,
    attempts: row.attempts,
    lastSentAt: row.last_sent_at
  };
}

/**
 * 每个用户每种用途至多一条记录，重新签发即覆盖。
 * 冷却时间也存在这里（last_sent_at），旧实现的 user.mailCooldown JSON 字段
 * 与整个 mailCooldown 模块因此可以消失。
 */
export class VerificationCodeRepository extends BaseRepository {
  async find(userId: string, purpose: VerificationPurpose): Promise<VerificationCode | null> {
    const row = await this.db
      .selectFrom('verification_codes')
      .selectAll()
      .where('user_id', '=', userId)
      .where('purpose', '=', purpose)
      .executeTakeFirst();
    return row ? toCode(row) : null;
  }

  /** 签发或覆盖。attempts 归零，冷却时间戳刷新。 */
  async upsert(input: {
    userId: string;
    purpose: VerificationPurpose;
    codeHash: string;
    expiresAt: string;
    sentAt: string;
  }): Promise<void> {
    const row: VerificationCodeRow = {
      user_id: input.userId,
      purpose: input.purpose,
      code_hash: input.codeHash,
      expires_at: input.expiresAt,
      attempts: 0,
      last_sent_at: input.sentAt
    };

    // 冲突列必须与主键一致。三方言的 upsert 语法**并不通用**，
    // 走 upsertRow 而不是直接 onConflict —— 见 db/upsert.ts
    await upsertRow(
      this.db.insertInto('verification_codes').values(row),
      this.driver,
      ['user_id', 'purpose'],
      {
        code_hash: row.code_hash,
        expires_at: row.expires_at,
        attempts: 0,
        last_sent_at: row.last_sent_at
      }
    ).execute();
  }

  async incrementAttempts(userId: string, purpose: VerificationPurpose): Promise<number> {
    await this.db
      .updateTable('verification_codes')
      .set((eb) => ({ attempts: eb('attempts', '+', 1) }))
      .where('user_id', '=', userId)
      .where('purpose', '=', purpose)
      .execute();

    const current = await this.find(userId, purpose);
    return current?.attempts ?? 0;
  }

  async delete(userId: string, purpose: VerificationPurpose): Promise<void> {
    await this.db
      .deleteFrom('verification_codes')
      .where('user_id', '=', userId)
      .where('purpose', '=', purpose)
      .execute();
  }
}

export const verificationCodeRepository = new VerificationCodeRepository();
