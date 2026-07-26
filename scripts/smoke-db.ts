/**
 * 数据层冒烟验证：建库 → 迁移 → 三类实体 CRUD → 级联 → 排名算法。
 * 正式测试落在 tests/ 下，这个脚本用于手工快速验证某个方言是否可用：
 *   npx tsx scripts/smoke-db.ts
 */
import { existsSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { createKysely } from '../app/db/dialects.js';
import { DbManager } from '../app/db/manager.js';
import { currentMigrationVersion, runMigrations } from '../app/db/migrator.js';
import { CategoryRepository } from '../app/repositories/categoryRepository.js';
import { EntryRepository } from '../app/repositories/entryRepository.js';
import { SettingsRepository } from '../app/repositories/settingsRepository.js';
import { UserRepository } from '../app/repositories/userRepository.js';
import { VerificationCodeRepository } from '../app/repositories/verificationCodeRepository.js';
import { rankEntries } from '../app/utils/ranking.js';

const DB_FILE = 'smoke-test.db';
const dbPath = resolve(process.cwd(), 'data', DB_FILE);
if (existsSync(dbPath)) unlinkSync(dbPath);

const manager = new DbManager();
const dbConfig = { driver: 'sqlite' as const, file: DB_FILE };
await manager.switchTo(await createKysely(dbConfig), dbConfig);

const { applied } = await runMigrations(manager.db());
console.log('✓ 迁移执行:', applied);
console.log('✓ 当前版本:', await currentMigrationVersion(manager.db()));

const users = new UserRepository(manager);
const entries = new EntryRepository(manager);
const categories = new CategoryRepository(manager);
const settings = new SettingsRepository(manager);
const codes = new VerificationCodeRepository(manager);

// --- 用户 ---
const user = await users.create({
  username: 'TestPlayer',
  email: 'Test@Example.com',
  passwordHash: '$2a$12$fakefakefakefakefakefakefakefakefakefakefakefakefakefak',
  role: 'User',
  emailVerified: false
});
console.log('✓ 建用户:', user.username, user.role, 'verified =', user.emailVerified);
console.log(
  '✓ 大小写不敏感查找:',
  Boolean(await users.findByUsername('testplayer')),
  Boolean(await users.findByEmail('TEST@EXAMPLE.COM')),
  Boolean(await users.findByIdentifier('test@example.com'))
);
console.log(
  '✓ 用户名占用检测:',
  await users.isUsernameTaken('TESTPLAYER'),
  await users.isUsernameTaken('nobody')
);

const promoted = await users.update(user.id, { role: 'Admin', emailVerified: true });
console.log('✓ 更新用户:', promoted.role, 'verified =', promoted.emailVerified);

// --- 验证码 ---
const issue = {
  userId: user.id,
  purpose: 'verify_email' as const,
  codeHash: 'abc123',
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  sentAt: new Date().toISOString()
};
await codes.upsert(issue);
console.log('✓ 签发验证码, attempts =', (await codes.find(user.id, 'verify_email'))?.attempts);
console.log('✓ 递增尝试次数 →', await codes.incrementAttempts(user.id, 'verify_email'));
await codes.upsert({ ...issue, codeHash: 'def456' });
console.log('✓ 重新签发后 attempts 归零 =', (await codes.find(user.id, 'verify_email'))?.attempts);

// --- 分类与条目 ---
const catMap = await categories.ensureMany(['Sword', 'Axe', 'Crystal']);
console.log('✓ 批量建分类:', [...catMap.keys()]);
console.log('✓ 分类名列表(字母序):', await categories.listNames());

const alice = await entries.create({
  player: 'Alice',
  rank: 'Master',
  points: 900,
  testServer: null,
  tiers: { Sword: 'HT1', Axe: 'LT2' }
});
const bob = await entries.create({
  player: 'Bob',
  rank: 'Ace',
  points: 900,
  testServer: 'Pico Test #3',
  tiers: { Crystal: 'HT3' }
});
await entries.create({
  player: 'Carol',
  rank: 'Cadet',
  points: 1200,
  testServer: null,
  tiers: {}
});

const all = await entries.listWithTiers();
console.log(
  '✓ 读回条目数:',
  all.length,
  '| Alice 的定级:',
  JSON.stringify(all.find((x) => x.player === 'Alice')?.tiers)
);

const ranked = rankEntries(all);
console.log(
  '✓ 竞技排名(应为 Carol#1 Alice#2 Bob#2):',
  ranked.map((r) => `${r.player}#${String(r.position)}`).join(' ')
);

const quick = await entries.quickUpdate(alice.id, { points: 1500 });
console.log('✓ 快编后 points =', quick.points, '| 定级保留 =', JSON.stringify(quick.tiers));

const full = await entries.update(alice.id, {
  player: 'Alice',
  rank: 'Grandmaster',
  points: 1500,
  testServer: null,
  tiers: { Sword: 'HT2' }
});
console.log('✓ 全量更新后定级 =', JSON.stringify(full.tiers));

await categories.delete(catMap.get('Sword')!);
console.log('✓ 删分类后级联清定级:', JSON.stringify((await entries.findById(alice.id))?.tiers));
console.log('✓ 删不存在的条目返回:', await entries.delete('entry-nope'));
console.log('✓ 删存在的条目返回:', await entries.delete(bob.id));

// --- 设置 ---
console.log('✓ 默认设置:', JSON.stringify(await settings.load()));
await settings.save({
  registrationEnabled: true,
  oauthMicrosoft: { clientId: 'abc', tenant: 'common' }
});
console.log('✓ 保存后:', JSON.stringify(await settings.load()));

// --- 删用户连带清理 ---
await users.delete(user.id);
console.log('✓ 删用户后验证码残留:', await codes.find(user.id, 'verify_email'));

await manager.close();
unlinkSync(dbPath);
console.log('\n全部通过。');
