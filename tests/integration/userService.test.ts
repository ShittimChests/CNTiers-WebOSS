import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../../app/errors/AppError.js';
import { ensureSuperAdmin } from '../../app/services/superAdminSeed.js';
import type { User } from '../../app/types/domain.js';
import { createServices, type TestServices } from '../helpers/services.js';
import { createTestDb, type TestDb } from '../helpers/testDb.js';

let db: TestDb;
let s: TestServices;

beforeAll(async () => {
  db = await createTestDb();
  s = createServices(db);
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.reset();
});

async function expectAppError(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(AppError.is(error)).toBe(true);
    expect((error as AppError).code).toBe(code);
    return;
  }
  throw new Error(`预期抛出 ${code}，但没有抛出`);
}

function makeUser(overrides: Partial<Parameters<TestServices['users']['create']>[0]> = {}) {
  return s.users.create({
    username: 'Member',
    email: 'member@example.com',
    passwordHash: 'hash',
    role: 'User',
    emailVerified: true,
    ...overrides
  });
}

describe('UserService · 角色变更', () => {
  let actor: User;

  beforeEach(async () => {
    actor = await makeUser({ username: 'Boss', email: 'boss@example.com', role: 'SuperAdmin' });
  });

  it('可以提升与降级普通用户', async () => {
    const target = await makeUser();

    expect((await s.userService.promote(target.id, actor.id)).role).toBe('Admin');
    expect((await s.userService.demote(target.id, actor.id)).role).toBe('User');
  });

  it('拒绝修改 SuperAdmin', async () => {
    const other = await makeUser({
      username: 'Root2',
      email: 'root2@example.com',
      role: 'SuperAdmin'
    });
    await expectAppError(s.userService.promote(other.id, actor.id), 'cannot_modify_super');
    await expectAppError(s.userService.demote(other.id, actor.id), 'cannot_modify_super');
    await expectAppError(s.userService.remove(other.id, actor.id), 'cannot_modify_super');
  });

  it('拒绝对自己操作', async () => {
    const admin = await makeUser({ username: 'Adm', email: 'adm@example.com', role: 'Admin' });
    await expectAppError(s.userService.demote(admin.id, admin.id), 'cannot_modify_self');
    await expectAppError(s.userService.remove(admin.id, admin.id), 'cannot_modify_self');
  });

  it('目标不存在时报 user_not_found', async () => {
    await expectAppError(s.userService.promote('user-nope', actor.id), 'user_not_found');
  });

  it('删除用户会连带清掉其会话', async () => {
    const target = await makeUser();
    await s.sessions.set({
      sid: 'sid-target',
      userId: target.id,
      data: '{}',
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });

    await s.userService.remove(target.id, actor.id);

    expect(await s.sessions.get('sid-target')).toBeNull();
    expect(await s.users.findById(target.id)).toBeNull();
  });

  it('列表按角色权重再按用户名排序', async () => {
    await makeUser({ username: 'zeta', email: 'z@example.com', role: 'User' });
    await makeUser({ username: 'alpha', email: 'a@example.com', role: 'Admin' });
    await makeUser({ username: 'beta', email: 'b@example.com', role: 'Admin' });

    expect((await s.userService.list()).map((u) => u.username)).toEqual([
      'Boss',
      'alpha',
      'beta',
      'zeta'
    ]);
  });

  it('revokeSessions 只清目标用户的会话', async () => {
    const target = await makeUser();
    const expires = new Date(Date.now() + 60_000).toISOString();
    await s.sessions.set({ sid: 'a', userId: target.id, data: '{}', expiresAt: expires });
    await s.sessions.set({ sid: 'b', userId: actor.id, data: '{}', expiresAt: expires });

    expect(await s.userService.revokeSessions(target.id)).toBe(1);
    expect(await s.sessions.get('a')).toBeNull();
    expect(await s.sessions.get('b')).not.toBeNull();
  });
});

describe('UserService · Microsoft 绑定', () => {
  it('绑定后可按 subject 找到，并把邮箱标记为已验证', async () => {
    const user = await makeUser({ emailVerified: false });
    const linked = await s.userService.linkMicrosoft(user.id, 'ms-1');

    expect(linked.oauthProvider).toBe('microsoft');
    expect(linked.emailVerified).toBe(true);
    expect((await s.users.findByOauth('microsoft', 'ms-1'))?.id).toBe(user.id);
  });

  it('同一个 Microsoft 账户不能绑到两个本地账号', async () => {
    const first = await makeUser();
    const second = await makeUser({ username: 'Other', email: 'other@example.com' });

    await s.userService.linkMicrosoft(first.id, 'ms-shared');
    await expectAppError(
      s.userService.linkMicrosoft(second.id, 'ms-shared'),
      'oauth_subject_taken'
    );
  });

  it('重复绑定同一账户是幂等的', async () => {
    const user = await makeUser();
    await s.userService.linkMicrosoft(user.id, 'ms-1');
    await expect(s.userService.linkMicrosoft(user.id, 'ms-1')).resolves.toMatchObject({
      oauthSubject: 'ms-1'
    });
  });

  it('没有本地密码时拒绝解绑（否则用户会被锁在门外）', async () => {
    const user = await makeUser({ passwordHash: null });
    await s.userService.linkMicrosoft(user.id, 'ms-1');

    await expectAppError(s.userService.unlinkMicrosoft(user.id), 'needs_password');
  });

  it('有本地密码时可解绑，只清掉绑定字段', async () => {
    const user = await makeUser();
    await s.userService.linkMicrosoft(user.id, 'ms-1');

    const unlinked = await s.userService.unlinkMicrosoft(user.id);
    expect(unlinked.oauthProvider).toBeNull();
    expect(unlinked.oauthSubject).toBeNull();
    expect(unlinked.passwordHash).not.toBeNull();
    expect(unlinked.emailVerified).toBe(true);
  });
});

describe('ensureSuperAdmin', () => {
  it('用户表为空时创建引导账号', async () => {
    await ensureSuperAdmin(s.users);

    const seeded = await s.users.findFirstByRole('SuperAdmin');
    expect(seeded).not.toBeNull();
    expect(seeded?.emailVerified).toBe(true);
    expect(seeded?.email).toBe(`${seeded!.username}@local`);
  });

  it('幂等：重复执行不会新建账号', async () => {
    await ensureSuperAdmin(s.users);
    const before = await s.users.count();
    await ensureSuperAdmin(s.users);

    expect(await s.users.count()).toBe(before);
  });

  it('env 指定的用户名已存在但角色不对时提升它', async () => {
    const { config } = await import('../../app/config/env.js');
    const existing = await makeUser({ username: config.superAdmin.username, role: 'User' });

    await ensureSuperAdmin(s.users);

    expect((await s.users.findById(existing.id))?.role).toBe('SuperAdmin');
    expect(await s.users.count()).toBe(1);
  });

  it('已有别的 SuperAdmin 时不做改动', async () => {
    await makeUser({ username: 'ExistingRoot', email: 'er@example.com', role: 'SuperAdmin' });

    await ensureSuperAdmin(s.users);

    expect(await s.users.count()).toBe(1);
    expect((await s.users.findByUsername('ExistingRoot'))?.role).toBe('SuperAdmin');
  });
});
