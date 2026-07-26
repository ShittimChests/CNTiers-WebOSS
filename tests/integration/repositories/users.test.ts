import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { UserRepository } from '../../../app/repositories/userRepository.js';
import { SessionRepository } from '../../../app/repositories/sessionRepository.js';
import { VerificationCodeRepository } from '../../../app/repositories/verificationCodeRepository.js';
import { createTestDb, type TestDb } from '../../helpers/testDb.js';

let db: TestDb;
let users: UserRepository;
let sessions: SessionRepository;
let codes: VerificationCodeRepository;

beforeAll(async () => {
  db = await createTestDb();
  users = new UserRepository(db.manager);
  sessions = new SessionRepository(db.manager);
  codes = new VerificationCodeRepository(db.manager);
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.reset();
});

const sampleUser = {
  username: 'TestPlayer',
  email: 'Test@Example.com',
  passwordHash: '$2a$12$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRS',
  role: 'User' as const,
  emailVerified: false
};

describe('UserRepository', () => {
  it('创建后能按 id 读回，布尔字段正确往返', async () => {
    const created = await users.create(sampleUser);
    const found = await users.findById(created.id);

    expect(found).not.toBeNull();
    expect(found?.username).toBe('TestPlayer');
    // 存储层是 0/1，领域层必须是 boolean
    expect(found?.emailVerified).toBe(false);
    expect(typeof found?.emailVerified).toBe('boolean');
  });

  it('用户名与邮箱查找不区分大小写，但原始大小写被保留', async () => {
    await users.create(sampleUser);

    expect((await users.findByUsername('testplayer'))?.username).toBe('TestPlayer');
    expect((await users.findByUsername('TESTPLAYER'))?.username).toBe('TestPlayer');
    expect((await users.findByEmail('TEST@EXAMPLE.COM'))?.email).toBe('Test@Example.com');
  });

  it('findByIdentifier 同时接受用户名与邮箱', async () => {
    const created = await users.create(sampleUser);
    expect((await users.findByIdentifier('TestPlayer'))?.id).toBe(created.id);
    expect((await users.findByIdentifier('test@example.com'))?.id).toBe(created.id);
    expect(await users.findByIdentifier('nobody')).toBeNull();
  });

  it('占用检测可排除自身，以支持改名', async () => {
    const created = await users.create(sampleUser);
    expect(await users.isUsernameTaken('testplayer')).toBe(true);
    expect(await users.isUsernameTaken('testplayer', created.id)).toBe(false);
    expect(await users.isEmailTaken('test@example.com', created.id)).toBe(false);
  });

  it('更新会同步维护小写影子列', async () => {
    const created = await users.create(sampleUser);
    await users.update(created.id, { username: 'Renamed' });

    expect(await users.findByUsername('renamed')).not.toBeNull();
    expect(await users.findByUsername('testplayer')).toBeNull();
  });

  it('更新只改传入的字段', async () => {
    const created = await users.create(sampleUser);
    const updated = await users.update(created.id, { role: 'Admin' });

    expect(updated.role).toBe('Admin');
    expect(updated.email).toBe(created.email);
    expect(updated.passwordHash).toBe(created.passwordHash);
  });

  it('passwordHash 可显式置空（OAuth-only 账户）', async () => {
    const created = await users.create(sampleUser);
    const updated = await users.update(created.id, { passwordHash: null });
    expect(updated.passwordHash).toBeNull();
  });

  it('按 OAuth subject 查找', async () => {
    const created = await users.create({
      ...sampleUser,
      oauthProvider: 'microsoft',
      oauthSubject: 'subject-abc'
    });
    expect((await users.findByOauth('microsoft', 'subject-abc'))?.id).toBe(created.id);
    expect(await users.findByOauth('microsoft', 'other')).toBeNull();
  });

  it('多个未绑定账户可共存（唯一约束允许多行 NULL）', async () => {
    await users.create(sampleUser);
    await users.create({ ...sampleUser, username: 'Second', email: 'second@example.com' });
    expect(await users.count()).toBe(2);
  });

  it('删除用户时连带清掉其会话与验证码', async () => {
    const created = await users.create(sampleUser);

    await sessions.set({
      sid: 'sid-1',
      userId: created.id,
      data: '{}',
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    await codes.upsert({
      userId: created.id,
      purpose: 'verify_email',
      codeHash: 'hash',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      sentAt: new Date().toISOString()
    });

    await users.delete(created.id);

    // 旧实现漏了这两步：被删用户的旧会话仍能通过 requireAuth
    expect(await sessions.get('sid-1')).toBeNull();
    expect(await codes.find(created.id, 'verify_email')).toBeNull();
    expect(await users.findById(created.id)).toBeNull();
  });

  it('deleteByUserExcept 只留下指定的那一个会话', async () => {
    // 改密码要的正是这个语义：踢掉别处的登录，留住正在操作的这一个
    const owner = await users.create(sampleUser);
    const other = await users.create({
      ...sampleUser,
      username: 'Other',
      email: 'other@example.com'
    });
    const expiresAt = new Date(Date.now() + 60_000).toISOString();

    for (const sid of ['keep', 'drop-1', 'drop-2']) {
      await sessions.set({ sid, userId: owner.id, data: '{}', expiresAt });
    }
    await sessions.set({ sid: 'someone-else', userId: other.id, data: '{}', expiresAt });

    expect(await sessions.deleteByUserExcept(owner.id, 'keep')).toBe(2);
    expect(await sessions.get('keep')).not.toBeNull();
    expect(await sessions.get('drop-1')).toBeNull();
    expect(await sessions.get('drop-2')).toBeNull();
    // 别人的会话不受影响
    expect(await sessions.get('someone-else')).not.toBeNull();
  });

  it('findFirstByRole 按创建时间取最早一条', async () => {
    await users.create({ ...sampleUser, role: 'SuperAdmin' });
    await users.create({
      ...sampleUser,
      username: 'Later',
      email: 'later@example.com',
      role: 'SuperAdmin'
    });
    expect((await users.findFirstByRole('SuperAdmin'))?.username).toBe('TestPlayer');
    expect(await users.findFirstByRole('Admin')).toBeNull();
  });
});
