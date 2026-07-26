const fs = require('node:fs/promises');
const path = require('node:path');
const bcrypt = require('bcryptjs');

// DATA_DIR 可由环境变量覆盖（默认行为不变），便于在隔离目录里录制 API 契约基线
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(__dirname, '../../data');
const LEADERBOARD_FILE = path.join(DATA_DIR, 'leaderboard.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

const SUPER_ADMIN_USERNAME = (process.env.ADMIN_USERNAME || 'admin').trim();

const DEFAULT_SETTINGS = {
  registrationEnabled: false,
  oauthEnabled: false,
  oauthMicrosoft: { clientId: '', tenant: 'common' },
  migrations: { categoryRenames_v1: false, userSchema_v1: false }
};

let cachedLeaderboard = null;
let cachedUsers = null;
let cachedSettings = null;

let leaderboardPromise = null;
let usersPromise = null;
let settingsPromise = null;

let isWriting = false;
const writeQueue = [];

async function flushWriteQueue() {
  if (isWriting || writeQueue.length === 0) return;
  isWriting = true;

  const { filePath, data, resolve, reject } = writeQueue.shift();
  const tempPath = `${filePath}.tmp`;
  try {
    await fs.writeFile(tempPath, JSON.stringify(data, null, 2), 'utf-8');
    await fs.rename(tempPath, filePath);
    resolve();
  } catch (error) {
    reject(error);
  } finally {
    isWriting = false;
    flushWriteQueue();
  }
}

function writeJson(filePath, data) {
  return new Promise((resolve, reject) => {
    writeQueue.push({ filePath, data, resolve, reject });
    flushWriteQueue();
  });
}

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function readJson(filePath, fallback) {
  try {
    const text = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(text);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return fallback;
    }
    throw error;
  }
}

async function getLeaderboard() {
  if (cachedLeaderboard) return cachedLeaderboard;
  if (!leaderboardPromise) {
    leaderboardPromise = readJson(LEADERBOARD_FILE, []).then((data) => {
      cachedLeaderboard = data;
      leaderboardPromise = null;
      return data;
    });
  }
  return leaderboardPromise;
}

async function saveLeaderboard(entries) {
  const ranked = rankEntries(entries);
  await writeJson(LEADERBOARD_FILE, ranked);
  cachedLeaderboard = ranked;
}

// 按 points 降序排，同分共享 position，下一个 position 跳号（1, 1, 3, 4, 4, 6 ...）
// 同分时按 player 名做稳定排序，避免每次写入后展示顺序乱跳。
function rankEntries(entries) {
  const sorted = [...entries].sort((a, b) => {
    const diff = Number(b?.points || 0) - Number(a?.points || 0);
    if (diff !== 0) return diff;
    return String(a?.player || '').localeCompare(String(b?.player || ''));
  });
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j < sorted.length && Number(sorted[j].points || 0) === Number(sorted[i].points || 0)) {
      sorted[j] = { ...sorted[j], position: i + 1 };
      j += 1;
    }
    i = j;
  }
  return sorted;
}

function buildSuperAdminSeed() {
  const username = SUPER_ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD || 'ChangeMe_12345';
  return {
    id: 'admin-1',
    username,
    email: `${username}@local`,
    passwordHash: bcrypt.hashSync(password, 12),
    role: 'SuperAdmin',
    emailVerified: true,
    verifyToken: null,
    verifyExpires: null,
    oauthProvider: null,
    oauthSubject: null,
    passwordResetToken: null,
    passwordResetExpires: null,
    verifyAttempts: 0,
    resetAttempts: 0,
    mailCooldown: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function migrateUserShape(user) {
  const next = { ...user };
  let changed = false;
  if (next.role === 'admin' || next.username === SUPER_ADMIN_USERNAME) {
    if (next.role !== 'SuperAdmin') { next.role = 'SuperAdmin'; changed = true; }
  }
  if (!['SuperAdmin', 'Admin', 'User'].includes(next.role)) {
    next.role = 'User';
    changed = true;
  }
  if (typeof next.email !== 'string' || next.email.length === 0) {
    next.email = `${next.username}@local`;
    changed = true;
  }
  if (typeof next.emailVerified !== 'boolean') {
    next.emailVerified = next.role === 'SuperAdmin';
    changed = true;
  }
  for (const key of ['verifyToken', 'verifyExpires', 'oauthProvider', 'oauthSubject', 'passwordResetToken', 'passwordResetExpires', 'verifyAttempts', 'resetAttempts']) {
    if (!(key in next)) {
      next[key] = (key === 'verifyAttempts' || key === 'resetAttempts') ? 0 : null;
      changed = true;
    }
  }
  if (!next.mailCooldown || typeof next.mailCooldown !== 'object') {
    next.mailCooldown = {};
    changed = true;
  }
  if (!next.updatedAt) { next.updatedAt = next.createdAt || new Date().toISOString(); changed = true; }
  return { user: next, changed };
}

async function getUsers() {
  if (cachedUsers) return cachedUsers;
  if (!usersPromise) {
    usersPromise = (async () => {
      const raw = await readJson(USERS_FILE, []);
      let users = raw;
      let needsWrite = false;

      if (users.length === 0) {
        users = [buildSuperAdminSeed()];
        needsWrite = true;
      } else {
        const migrated = users.map(migrateUserShape);
        if (migrated.some((m) => m.changed)) needsWrite = true;
        users = migrated.map((m) => m.user);
        const hasSuper = users.some((u) => u.role === 'SuperAdmin');
        if (!hasSuper) {
          const target = users.find((u) => u.username === SUPER_ADMIN_USERNAME);
          if (target) {
            target.role = 'SuperAdmin';
            target.emailVerified = true;
            needsWrite = true;
          } else {
            users.push(buildSuperAdminSeed());
            needsWrite = true;
          }
        }
      }

      if (needsWrite) await writeJson(USERS_FILE, users);
      cachedUsers = users;
      usersPromise = null;
      return users;
    })();
  }
  return usersPromise;
}

async function saveUsers(users) {
  await writeJson(USERS_FILE, users);
  cachedUsers = users;
}

async function findUserByUsername(username) {
  const users = await getUsers();
  const lc = String(username || '').trim().toLowerCase();
  return users.find((u) => u.username.toLowerCase() === lc) || null;
}

async function findUserByEmail(email) {
  const users = await getUsers();
  const lc = String(email || '').trim().toLowerCase();
  return users.find((u) => (u.email || '').toLowerCase() === lc) || null;
}

async function findUserById(id) {
  const users = await getUsers();
  return users.find((u) => u.id === id) || null;
}

async function findUserByVerifyToken(token) {
  const users = await getUsers();
  if (!token) return null;
  return users.find((u) => u.verifyToken === token) || null;
}

async function findUserByPasswordResetToken(token) {
  const users = await getUsers();
  if (!token) return null;
  return users.find((u) => u.passwordResetToken === token) || null;
}

async function findUserByOauth(provider, subject) {
  const users = await getUsers();
  if (!provider || !subject) return null;
  return users.find((u) => u.oauthProvider === provider && u.oauthSubject === subject) || null;
}

async function upsertUser(user) {
  const users = await getUsers();
  const idx = users.findIndex((u) => u.id === user.id);
  const stamped = { ...user, updatedAt: new Date().toISOString() };
  if (idx === -1) users.push(stamped); else users[idx] = stamped;
  await saveUsers(users);
  return stamped;
}

async function deleteUser(id) {
  const users = await getUsers();
  const next = users.filter((u) => u.id !== id);
  await saveUsers(next);
}

async function getSettings() {
  if (cachedSettings) return cachedSettings;
  if (!settingsPromise) {
    settingsPromise = (async () => {
      const raw = await readJson(SETTINGS_FILE, null);
      const merged = mergeSettings(DEFAULT_SETTINGS, raw || {});
      if (!raw) await writeJson(SETTINGS_FILE, merged);
      cachedSettings = merged;
      settingsPromise = null;
      return merged;
    })();
  }
  return settingsPromise;
}

function mergeSettings(base, incoming) {
  const out = { ...base };
  for (const key of Object.keys(base)) {
    if (key in incoming) {
      const bv = base[key];
      const iv = incoming[key];
      if (bv && typeof bv === 'object' && !Array.isArray(bv) && iv && typeof iv === 'object') {
        out[key] = mergeSettings(bv, iv);
      } else if (typeof bv === typeof iv || iv === null) {
        out[key] = iv;
      }
    }
  }
  return out;
}

async function saveSettings(next) {
  const current = await getSettings();
  const merged = mergeSettings(current, next);
  await writeJson(SETTINGS_FILE, merged);
  cachedSettings = merged;
  return merged;
}

function invalidateCache() {
  cachedLeaderboard = null;
  cachedUsers = null;
  cachedSettings = null;
}

module.exports = {
  ensureDataDir,
  getLeaderboard,
  saveLeaderboard,
  getUsers,
  saveUsers,
  findUserByUsername,
  findUserByEmail,
  findUserById,
  findUserByVerifyToken,
  findUserByPasswordResetToken,
  findUserByOauth,
  upsertUser,
  deleteUser,
  getSettings,
  saveSettings,
  invalidateCache,
  LEADERBOARD_FILE,
  USERS_FILE,
  SETTINGS_FILE,
  SUPER_ADMIN_USERNAME
};
