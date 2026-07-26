/**
 * 三条 upsert 路径的跨方言执行验证。
 *
 * 这个文件补的是一条真实存在过的缝：Kysely 的 `onConflict()` 是
 * PostgreSQL / SQLite 语法，`MysqlQueryCompiler` 不翻译它，MySQL 上直接
 * `ER_PARSE_ERROR`。修复（app/db/upsert.ts）之后加的守卫是
 * tests/unit/upsert.test.ts——但它用 DummyDriver 只**编译** SQL，
 * `onDuplicateKeyUpdate()` 生成的语句从未在真的 MySQL 上执行过。
 *
 * 而 CI 的方言矩阵跑的是 `npm run test:repo`（= 本目录），此前只有
 * entries 与 users 两个文件，两者都不含 upsert。于是「SQL 形状对不对」和
 * 「跑起来对不对」被分在了两道防线里，中间恰好漏掉了出过事的那三张表：
 * sessions（每次登录）、settings（后台保存）、verification_codes（注册/重发）。
 *
 * 断言刻意都走「插入 → 同键再写 → 读回」，因为 upsert 的错误方式只有两种：
 * 语法不被接受，或者冲突时插了第二行而不是更新。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SessionRepository } from '../../../app/repositories/sessionRepository.js';
import { SettingsRepository } from '../../../app/repositories/settingsRepository.js';
import { UserRepository } from '../../../app/repositories/userRepository.js';
import { VerificationCodeRepository } from '../../../app/repositories/verificationCodeRepository.js';
import { createTestDb, type TestDb } from '../../helpers/testDb.js';

let db: TestDb;
let sessions: SessionRepository;
let settings: SettingsRepository;
let codes: VerificationCodeRepository;
let users: UserRepository;

beforeAll(async () => {
  db = await createTestDb();
  sessions = new SessionRepository(db.manager);
  settings = new SettingsRepository(db.manager);
  codes = new VerificationCodeRepository(db.manager);
  users = new UserRepository(db.manager);
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.reset();
});

describe('sessions 的 upsert（登录路径）', () => {
  it('同一个 sid 再写一次是更新而不是插入', async () => {
    await sessions.set({
      sid: 'sid-1',
      userId: null,
      data: '{"v":1}',
      expiresAt: '2030-01-01T00:00:00.000Z'
    });
    await sessions.set({
      sid: 'sid-1',
      userId: null,
      data: '{"v":2}',
      expiresAt: '2030-01-02T00:00:00.000Z'
    });

    expect(await sessions.count()).toBe(1);
    const stored = await sessions.get('sid-1');
    expect(stored?.data).toBe('{"v":2}');
    expect(stored?.expiresAt).toBe('2030-01-02T00:00:00.000Z');
  });

  it('user_id 可以从 null 变成具体用户（匿名会话登录后的形态）', async () => {
    const user = await users.create({
      username: 'SessionOwner',
      email: 'session-owner@example.com',
      passwordHash: null,
      role: 'User',
      emailVerified: true
    });

    await sessions.set({
      sid: 'sid-2',
      userId: null,
      data: '{}',
      expiresAt: '2030-01-01T00:00:00.000Z'
    });
    await sessions.set({
      sid: 'sid-2',
      userId: user.id,
      data: '{}',
      expiresAt: '2030-01-01T00:00:00.000Z'
    });

    expect(await sessions.count()).toBe(1);
    expect((await sessions.get('sid-2'))?.userId).toBe(user.id);
  });
});

describe('settings 的 upsert（后台保存路径）', () => {
  it('连续保存两次，第二次覆盖第一次', async () => {
    await settings.save({ registrationEnabled: true });
    await settings.save({ registrationEnabled: false, oauthEnabled: true });

    const loaded = await settings.load();
    expect(loaded.registrationEnabled).toBe(false);
    expect(loaded.oauthEnabled).toBe(true);
  });

  it('嵌套对象字段往返后仍是对象', async () => {
    await settings.save({ oauthMicrosoft: { clientId: 'abc', tenant: 'contoso' } });
    expect((await settings.load()).oauthMicrosoft).toEqual({
      clientId: 'abc',
      tenant: 'contoso'
    });
  });
});

describe('verification_codes 的 upsert（注册 / 重发路径）', () => {
  it('同一 (用户, 用途) 重新签发是覆盖，且尝试次数归零', async () => {
    const user = await users.create({
      username: 'CodeOwner',
      email: 'code-owner@example.com',
      passwordHash: null,
      role: 'User',
      emailVerified: false
    });

    await codes.upsert({
      userId: user.id,
      purpose: 'verify_email',
      codeHash: 'hash-1',
      expiresAt: '2030-01-01T00:00:00.000Z',
      sentAt: '2026-01-01T00:00:00.000Z'
    });
    expect(await codes.incrementAttempts(user.id, 'verify_email')).toBe(1);

    await codes.upsert({
      userId: user.id,
      purpose: 'verify_email',
      codeHash: 'hash-2',
      expiresAt: '2030-01-02T00:00:00.000Z',
      sentAt: '2026-01-02T00:00:00.000Z'
    });

    const record = await codes.find(user.id, 'verify_email');
    expect(record?.codeHash).toBe('hash-2');
    // 新码必须配新的计数，否则上一轮的错误次数会跟着继承下来
    expect(record?.attempts).toBe(0);
  });

  it('两种用途各存一行，互不覆盖', async () => {
    const user = await users.create({
      username: 'TwoPurposes',
      email: 'two-purposes@example.com',
      passwordHash: null,
      role: 'User',
      emailVerified: false
    });

    for (const purpose of ['verify_email', 'reset_password'] as const) {
      await codes.upsert({
        userId: user.id,
        purpose,
        codeHash: `hash-${purpose}`,
        expiresAt: '2030-01-01T00:00:00.000Z',
        sentAt: '2026-01-01T00:00:00.000Z'
      });
    }

    expect((await codes.find(user.id, 'verify_email'))?.codeHash).toBe('hash-verify_email');
    expect((await codes.find(user.id, 'reset_password'))?.codeHash).toBe('hash-reset_password');
  });
});
