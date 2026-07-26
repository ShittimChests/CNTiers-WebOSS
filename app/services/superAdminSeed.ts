import bcrypt from 'bcryptjs';
import { BCRYPT_COST } from '../config/constants.js';
import { config } from '../config/env.js';
import { userRepository, type UserRepository } from '../repositories/userRepository.js';

/**
 * 保证「恰好存在一个可登录的 SuperAdmin」这个不变量，在每次启动时执行。
 *
 * 三种情形，与旧实现的 getUsers() 语义一致：
 *   1. env 指定的用户名存在但角色不对 → 提升为 SuperAdmin
 *   2. 已有别的 SuperAdmin → 什么都不做（避免每次重启都改动数据）
 *   3. 谁都没有 → 用 env 的用户名与密码创建
 *
 * 与旧实现的区别：这里用异步的 bcrypt.hash。旧实现在启动路径上调
 * hashSync（cost 12 约 300ms），把事件循环整块卡住。
 */
export async function ensureSuperAdmin(users: UserRepository = userRepository): Promise<void> {
  const username = config.superAdmin.username;

  const named = await users.findByUsername(username);
  if (named) {
    if (named.role !== 'SuperAdmin') {
      await users.update(named.id, { role: 'SuperAdmin', emailVerified: true });
      console.info(`已把用户 ${named.username} 提升为 SuperAdmin（由 ADMIN_USERNAME 指定）。`);
    }
    warnAboutDefaultPassword();
    return;
  }

  const existing = await users.findFirstByRole('SuperAdmin');
  if (existing) {
    console.warn(
      `⚠️  ADMIN_USERNAME=${username} 对应的账号不存在，但已有 SuperAdmin（${existing.username}），不做改动。`
    );
    return;
  }

  await users.create({
    username,
    // 引导账号没有真实邮箱；沿用旧实现的占位形式，忘记密码流程对它无效
    email: `${username}@local`,
    passwordHash: await bcrypt.hash(config.superAdmin.password, BCRYPT_COST),
    role: 'SuperAdmin',
    emailVerified: true
  });
  console.info(`已创建引导管理员账号：${username}`);
  warnAboutDefaultPassword();
}

function warnAboutDefaultPassword(): void {
  if (!config.superAdmin.isDefaultPassword) return;
  console.warn(
    '⚠️  管理员密码仍是默认值 ChangeMe_12345。请在 .env 中设置 ADMIN_PASSWORD，' +
      '或登录后在账户页修改密码。'
  );
}
