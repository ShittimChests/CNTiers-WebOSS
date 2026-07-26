/**
 * 用同一个测试数据库组装一整套服务实例。
 *
 * 所有依赖都从构造函数注入，因此测试拿到的是真实的 repository + 真实数据库
 * （SQLite 内存库），只有发信被替换成 FakeMailer——那是唯一会打到外部
 * 网络的边界。这比 mock 掉 repository 更有价值：跨方言的 SQL 也一起被验证了。
 */
import { CategoryRepository } from '../../app/repositories/categoryRepository.js';
import { EntryRepository } from '../../app/repositories/entryRepository.js';
import { SessionRepository } from '../../app/repositories/sessionRepository.js';
import { SettingsRepository } from '../../app/repositories/settingsRepository.js';
import { UserRepository } from '../../app/repositories/userRepository.js';
import { VerificationCodeRepository } from '../../app/repositories/verificationCodeRepository.js';
import { AuthService } from '../../app/services/authService.js';
import { CategoryService } from '../../app/services/categoryService.js';
import { LeaderboardService } from '../../app/services/leaderboardService.js';
import { FakeMailer } from '../../app/services/mail/mailer.js';
import { SettingsService } from '../../app/services/settingsService.js';
import { UserService } from '../../app/services/userService.js';
import { VerificationService } from '../../app/services/verificationService.js';
import type { TestDb } from './testDb.js';

/** 测试用的低强度 cost：cost 12 每次约 300ms，会把套件拖到十几秒。 */
const TEST_BCRYPT_COST = 4;
const TEST_SECRET = 'test-secret-for-hmac-derivation';

export interface TestServices {
  users: UserRepository;
  codes: VerificationCodeRepository;
  entries: EntryRepository;
  categories: CategoryRepository;
  sessions: SessionRepository;
  settingsRepo: SettingsRepository;
  settings: SettingsService;
  verification: VerificationService;
  mailer: FakeMailer;
  auth: AuthService;
  userService: UserService;
  leaderboard: LeaderboardService;
  categoryService: CategoryService;
  bcryptCost: number;
}

export function createServices(db: TestDb): TestServices {
  const users = new UserRepository(db.manager);
  const codes = new VerificationCodeRepository(db.manager);
  const entries = new EntryRepository(db.manager);
  const categories = new CategoryRepository(db.manager);
  const sessions = new SessionRepository(db.manager);
  const settingsRepo = new SettingsRepository(db.manager);

  const settings = new SettingsService(settingsRepo);
  const verification = new VerificationService(codes, TEST_SECRET);
  const mailer = new FakeMailer();

  return {
    users,
    codes,
    entries,
    categories,
    sessions,
    settingsRepo,
    settings,
    verification,
    mailer,
    auth: new AuthService(users, verification, mailer, settings, TEST_BCRYPT_COST),
    userService: new UserService(users, sessions),
    leaderboard: new LeaderboardService(entries, categories),
    categoryService: new CategoryService(categories),
    bcryptCost: TEST_BCRYPT_COST
  };
}
