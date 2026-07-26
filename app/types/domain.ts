import type { Role, VerificationPurpose } from '../config/constants.js';

/**
 * 领域模型 —— 与数据库行形状解耦。
 * repository 负责 snake_case 行 ↔ camelCase 领域对象的转换，
 * 以及 0/1 ↔ boolean 这类跨方言归一。
 */

export interface User {
  id: string;
  username: string;
  email: string;
  /** OAuth-only 账户为 null。为 null 时禁止解绑，否则用户将无法登录。 */
  passwordHash: string | null;
  role: Role;
  emailVerified: boolean;
  oauthProvider: string | null;
  oauthSubject: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 可安全放进会话与视图的用户投影：绝不含哈希与令牌。 */
export interface PublicUser {
  id: string;
  username: string;
  email: string;
  role: Role;
}

export function toPublicUser(user: User): PublicUser {
  return { id: user.id, username: user.username, email: user.email, role: user.role };
}

export interface NewUser {
  username: string;
  email: string;
  passwordHash: string | null;
  role: Role;
  emailVerified: boolean;
  oauthProvider?: string | null;
  oauthSubject?: string | null;
}

export interface UserPatch {
  username?: string;
  email?: string;
  passwordHash?: string | null;
  role?: Role;
  emailVerified?: boolean;
  oauthProvider?: string | null;
  oauthSubject?: string | null;
}

export interface VerificationCode {
  userId: string;
  purpose: VerificationPurpose;
  codeHash: string;
  expiresAt: string;
  attempts: number;
  lastSentAt: string;
}

export interface Category {
  id: string;
  name: string;
  createdAt: string;
}

/** 榜单条目。tiers 只含已定级的项目——未定级即不存在，与存储形状一致。 */
export interface Entry {
  id: string;
  player: string;
  rank: string;
  points: number;
  testServer: string | null;
  tiers: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

/**
 * 带名次的条目。position 是派生值，由 rankEntries 在读取时计算，
 * 从不落库——旧实现每次写入都要重排全表正是因为把它存了下来。
 */
export interface RankedEntry extends Entry {
  position: number;
}

export interface NewEntry {
  player: string;
  rank: string;
  points: number;
  testServer: string | null;
  tiers: Record<string, string>;
}

/** 快速编辑只覆盖这三个字段，细分项目原样保留。 */
export interface EntryQuickPatch {
  rank?: string;
  points?: number;
  testServer?: string | null;
}

export interface AppSettings {
  registrationEnabled: boolean;
  oauthEnabled: boolean;
  oauthMicrosoft: {
    clientId: string;
    tenant: string;
  };
}

export const DEFAULT_SETTINGS: AppSettings = {
  registrationEnabled: false,
  oauthEnabled: false,
  oauthMicrosoft: { clientId: '', tenant: 'common' }
};
