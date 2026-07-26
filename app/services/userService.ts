import { ROLE_WEIGHT, type Role } from '../config/constants.js';
import { AppError } from '../errors/AppError.js';
import { sessionRepository, type SessionRepository } from '../repositories/sessionRepository.js';
import { userRepository, type UserRepository } from '../repositories/userRepository.js';
import type { User } from '../types/domain.js';

/**
 * 用户管理（仅 SuperAdmin 可用）。
 *
 * SuperAdmin 的不变量集中在这里，而不是散落到各个路由：
 * 不可降级、不可删除、不可改名；任何人也不能对自己执行管理操作。
 * 旧实现把这三条守卫在两处各抄了一遍，删除用户那条路径还漏掉了复用。
 */
export class UserService {
  constructor(
    private readonly users: UserRepository = userRepository,
    private readonly sessions: SessionRepository = sessionRepository
  ) {}

  /** 用户列表，按角色权重再按用户名排序。 */
  async list(): Promise<User[]> {
    const all = await this.users.list();
    return all.sort((a, b) => {
      const byRole = ROLE_WEIGHT[a.role] - ROLE_WEIGHT[b.role];
      return byRole !== 0 ? byRole : a.username.localeCompare(b.username);
    });
  }

  async getById(id: string): Promise<User> {
    const user = await this.users.findById(id);
    if (!user) throw new AppError('user_not_found');
    return user;
  }

  /** 所有管理操作的公共守卫。 */
  async #assertManageable(targetId: string, actorId: string): Promise<User> {
    const target = await this.getById(targetId);
    if (target.role === 'SuperAdmin') throw new AppError('cannot_modify_super');
    if (target.id === actorId) throw new AppError('cannot_modify_self');
    return target;
  }

  async changeRole(
    targetId: string,
    actorId: string,
    role: Exclude<Role, 'SuperAdmin'>
  ): Promise<User> {
    await this.#assertManageable(targetId, actorId);
    return this.users.update(targetId, { role });
  }

  promote(targetId: string, actorId: string): Promise<User> {
    return this.changeRole(targetId, actorId, 'Admin');
  }

  demote(targetId: string, actorId: string): Promise<User> {
    return this.changeRole(targetId, actorId, 'User');
  }

  /** 删除用户。其会话与验证码由 repository 在同一事务里清理。 */
  async remove(targetId: string, actorId: string): Promise<void> {
    await this.#assertManageable(targetId, actorId);
    await this.users.delete(targetId);
  }

  /**
   * 绑定 Microsoft 账户。
   * 同一个 Microsoft subject 不能绑到两个本地账号上。
   */
  async linkMicrosoft(userId: string, subject: string): Promise<User> {
    const existing = await this.users.findByOauth('microsoft', subject);
    if (existing && existing.id !== userId) {
      throw new AppError('oauth_subject_taken');
    }
    // 能完成 Microsoft 授权即证明邮箱可达
    return this.users.update(userId, {
      oauthProvider: 'microsoft',
      oauthSubject: subject,
      emailVerified: true
    });
  }

  /** 解绑。没有本地密码时拒绝，否则用户将无法登录。 */
  async unlinkMicrosoft(userId: string): Promise<User> {
    const user = await this.getById(userId);
    if (!user.passwordHash) throw new AppError('needs_password');

    return this.users.update(userId, { oauthProvider: null, oauthSubject: null });
  }

  /**
   * 强制某个用户的会话失效（改密码、被降级等场景）。
   *
   * 传 exceptSid 时保留那一个——改密码的调用方需要留住当前浏览器，
   * 否则用户刚改完密码就被踢下线。
   */
  async revokeSessions(userId: string, exceptSid?: string): Promise<number> {
    return exceptSid === undefined
      ? this.sessions.deleteByUser(userId)
      : this.sessions.deleteByUserExcept(userId, exceptSid);
  }
}

export const userService = new UserService();
