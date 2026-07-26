const fs = require('node:fs/promises');
const path = require('node:path');
const session = require('express-session');

const { Store } = session;

// 与 dataStore.js 保持一致：允许用 DATA_DIR 覆盖，默认行为不变
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(__dirname, '../../data');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

function nowMs() { return Date.now(); }

function isExpired(record) {
  if (!record || typeof record !== 'object') return true;
  const expiresAt = record.expiresAt;
  if (typeof expiresAt !== 'number') return false;
  return expiresAt <= nowMs();
}

class FileSessionStore extends Store {
  constructor(options = {}) {
    super(options);
    this.sweepEveryMs = options.sweepEveryMs || 5 * 60 * 1000;
    this.cache = null;
    this.loadPromise = null;
    this.writeQueue = [];
    this.isWriting = false;
    this.lastSweepAt = 0;
  }

  async _load() {
    if (this.cache) return this.cache;
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = (async () => {
      try {
        await fs.mkdir(DATA_DIR, { recursive: true });
        const text = await fs.readFile(SESSIONS_FILE, 'utf-8');
        const parsed = JSON.parse(text);
        this.cache = (parsed && typeof parsed === 'object') ? parsed : {};
      } catch (error) {
        if (error.code === 'ENOENT' || error instanceof SyntaxError) {
          this.cache = {};
        } else {
          this.loadPromise = null;
          throw error;
        }
      }
      this.loadPromise = null;
      return this.cache;
    })();
    return this.loadPromise;
  }

  _scheduleWrite() {
    return new Promise((resolve, reject) => {
      this.writeQueue.push({ resolve, reject });
      this._flushWrite();
    });
  }

  async _flushWrite() {
    if (this.isWriting || this.writeQueue.length === 0) return;
    this.isWriting = true;
    const pending = this.writeQueue.splice(0, this.writeQueue.length);
    try {
      const tempPath = `${SESSIONS_FILE}.tmp`;
      await fs.writeFile(tempPath, JSON.stringify(this.cache || {}, null, 2), 'utf-8');
      await fs.rename(tempPath, SESSIONS_FILE);
      pending.forEach((p) => p.resolve());
    } catch (error) {
      pending.forEach((p) => p.reject(error));
    } finally {
      this.isWriting = false;
      if (this.writeQueue.length > 0) this._flushWrite();
    }
  }

  async _maybeSweep() {
    const now = nowMs();
    if (now - this.lastSweepAt < this.sweepEveryMs) return false;
    this.lastSweepAt = now;
    let mutated = false;
    for (const [sid, record] of Object.entries(this.cache || {})) {
      if (isExpired(record)) {
        delete this.cache[sid];
        mutated = true;
      }
    }
    return mutated;
  }

  get(sid, callback) {
    this._load().then(async (cache) => {
      const record = cache[sid];
      if (!record) return callback(null, null);
      if (isExpired(record)) {
        delete cache[sid];
        await this._scheduleWrite().catch(() => {});
        return callback(null, null);
      }
      callback(null, record.session);
    }).catch((err) => callback(err));
  }

  set(sid, sessionData, callback) {
    this._load().then(async (cache) => {
      const cookie = sessionData && sessionData.cookie;
      const expiresAt = cookie && cookie.expires
        ? new Date(cookie.expires).getTime()
        : (cookie && cookie.maxAge ? nowMs() + cookie.maxAge : nowMs() + 8 * 60 * 60 * 1000);
      cache[sid] = { session: sessionData, expiresAt };
      const sweptSomething = await this._maybeSweep();
      void sweptSomething;
      await this._scheduleWrite();
      callback && callback(null);
    }).catch((err) => callback && callback(err));
  }

  destroy(sid, callback) {
    this._load().then(async (cache) => {
      if (cache[sid]) {
        delete cache[sid];
        await this._scheduleWrite();
      }
      callback && callback(null);
    }).catch((err) => callback && callback(err));
  }

  touch(sid, sessionData, callback) {
    this._load().then(async (cache) => {
      const record = cache[sid];
      if (!record) return callback && callback(null);
      const cookie = sessionData && sessionData.cookie;
      record.expiresAt = cookie && cookie.expires
        ? new Date(cookie.expires).getTime()
        : (cookie && cookie.maxAge ? nowMs() + cookie.maxAge : record.expiresAt);
      await this._scheduleWrite();
      callback && callback(null);
    }).catch((err) => callback && callback(err));
  }

  all(callback) {
    this._load().then((cache) => {
      const out = {};
      for (const [sid, record] of Object.entries(cache)) {
        if (!isExpired(record)) out[sid] = record.session;
      }
      callback(null, out);
    }).catch((err) => callback(err));
  }

  length(callback) {
    this._load().then((cache) => {
      let n = 0;
      for (const record of Object.values(cache)) if (!isExpired(record)) n += 1;
      callback(null, n);
    }).catch((err) => callback(err));
  }

  clear(callback) {
    this._load().then(async () => {
      this.cache = {};
      await this._scheduleWrite();
      callback && callback(null);
    }).catch((err) => callback && callback(err));
  }
}

module.exports = { FileSessionStore, SESSIONS_FILE };
