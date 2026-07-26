import type { Role } from '../config/constants.js';
import type { UserRow, UserRowUpdate } from '../db/types.js';
import type { NewUser, User, UserPatch } from '../types/domain.js';
import { BaseRepository, fromBool, lower, newId, nowIso, toBool } from './base.js';

function toUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    passwordHash: row.password_hash,
    role: row.role as Role,
    emailVerified: toBool(row.email_verified),
    oauthProvider: row.oauth_provider,
    oauthSubject: row.oauth_subject,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export class UserRepository extends BaseRepository {
  async findById(id: string): Promise<User | null> {
    const row = await this.db
      .selectFrom('users')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? toUser(row) : null;
  }

  async findByUsername(username: string): Promise<User | null> {
    const row = await this.db
      .selectFrom('users')
      .selectAll()
      .where('username_lower', '=', lower(username))
      .executeTakeFirst();
    return row ? toUser(row) : null;
  }

  async findByEmail(email: string): Promise<User | null> {
    const row = await this.db
      .selectFrom('users')
      .selectAll()
      .where('email_lower', '=', lower(email))
      .executeTakeFirst();
    return row ? toUser(row) : null;
  }

  /** 登录允许用用户名或邮箱，这里一次查完两种可能。 */
  async findByIdentifier(identifier: string): Promise<User | null> {
    const key = lower(identifier);
    const row = await this.db
      .selectFrom('users')
      .selectAll()
      .where((eb) => eb.or([eb('username_lower', '=', key), eb('email_lower', '=', key)]))
      .executeTakeFirst();
    return row ? toUser(row) : null;
  }

  async findByOauth(provider: string, subject: string): Promise<User | null> {
    const row = await this.db
      .selectFrom('users')
      .selectAll()
      .where('oauth_provider', '=', provider)
      .where('oauth_subject', '=', subject)
      .executeTakeFirst();
    return row ? toUser(row) : null;
  }

  async list(): Promise<User[]> {
    const rows = await this.db
      .selectFrom('users')
      .selectAll()
      .orderBy('created_at', 'asc')
      .execute();
    return rows.map(toUser);
  }

  async count(): Promise<number> {
    const row = await this.db
      .selectFrom('users')
      .select((eb) => eb.fn.countAll<string | number>().as('total'))
      .executeTakeFirstOrThrow();
    return Number(row.total);
  }

  async findFirstByRole(role: Role): Promise<User | null> {
    const row = await this.db
      .selectFrom('users')
      .selectAll()
      .where('role', '=', role)
      .orderBy('created_at', 'asc')
      .executeTakeFirst();
    return row ? toUser(row) : null;
  }

  async create(input: NewUser): Promise<User> {
    const timestamp = nowIso();
    const row = {
      id: newId('user'),
      username: input.username,
      username_lower: lower(input.username),
      email: input.email,
      email_lower: lower(input.email),
      password_hash: input.passwordHash,
      role: input.role,
      email_verified: fromBool(input.emailVerified),
      oauth_provider: input.oauthProvider ?? null,
      oauth_subject: input.oauthSubject ?? null,
      created_at: timestamp,
      updated_at: timestamp
    };
    await this.db.insertInto('users').values(row).execute();
    return toUser(row);
  }

  async update(id: string, patch: UserPatch): Promise<User> {
    const values: UserRowUpdate = { updated_at: nowIso() };

    if (patch.username !== undefined) {
      values.username = patch.username;
      values.username_lower = lower(patch.username);
    }
    if (patch.email !== undefined) {
      values.email = patch.email;
      values.email_lower = lower(patch.email);
    }
    if (patch.passwordHash !== undefined) values.password_hash = patch.passwordHash;
    if (patch.role !== undefined) values.role = patch.role;
    if (patch.emailVerified !== undefined) values.email_verified = fromBool(patch.emailVerified);
    if (patch.oauthProvider !== undefined) values.oauth_provider = patch.oauthProvider;
    if (patch.oauthSubject !== undefined) values.oauth_subject = patch.oauthSubject;

    await this.db.updateTable('users').set(values).where('id', '=', id).execute();

    const updated = await this.findById(id);
    if (!updated) throw new Error(`更新后找不到用户 ${id}`);
    return updated;
  }

  /**
   * 删除用户，并连带清掉其全部会话。
   * 旧实现漏了后半步——被删用户的旧会话仍能通过 requireAuth。
   */
  async delete(id: string): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('sessions').where('user_id', '=', id).execute();
      await trx.deleteFrom('verification_codes').where('user_id', '=', id).execute();
      await trx.deleteFrom('users').where('id', '=', id).execute();
    });
  }

  /** 用户名冲突检测；排除自身以便改名场景复用。 */
  async isUsernameTaken(username: string, exceptId?: string): Promise<boolean> {
    let query = this.db
      .selectFrom('users')
      .select('id')
      .where('username_lower', '=', lower(username));
    if (exceptId) query = query.where('id', '!=', exceptId);
    return (await query.executeTakeFirst()) !== undefined;
  }

  async isEmailTaken(email: string, exceptId?: string): Promise<boolean> {
    let query = this.db.selectFrom('users').select('id').where('email_lower', '=', lower(email));
    if (exceptId) query = query.where('id', '!=', exceptId);
    return (await query.executeTakeFirst()) !== undefined;
  }
}

export const userRepository = new UserRepository();
