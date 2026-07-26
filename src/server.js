require('dotenv').config();

const path = require('node:path');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const csurf = require('csurf');
const { z } = require('zod');

const {
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
  deleteUser: removeUser,
  getSettings,
  saveSettings,
  SUPER_ADMIN_USERNAME
} = require('./services/dataStore');
const { importExcelIfNeeded } = require('./services/excelImport');
const {
  ensureRequiredRenames,
  listCategories,
  addCategory,
  renameCategory,
  deleteCategory
} = require('./services/categoryService');
const {
  sendVerificationCode,
  sendPasswordResetCode,
  generateCode,
  VERIFY_TTL_MS,
  RESET_TTL_MS,
  MAIL_COOLDOWN_MS,
  MAX_CODE_ATTEMPTS
} = require('./services/emailService');
const { isCooledDown, remainingCooldownSeconds, stampMailSent } = require('./services/mailCooldown');
const { isMicrosoftEnabled, buildAuthUrl, exchangeCode, fetchProfile } = require('./services/oauthService');
const { FileSessionStore } = require('./services/sessionFileStore');
const { requireAuth, requireSuperAdmin, requireAdminOrAbove } = require('./middleware/auth');
const { generateToken, timingSafeEqualString } = require('./utils/tokens');
const {
  leaderboardSchema,
  quickEditSchema,
  loginSchema,
  registerSchema,
  forgotSchema,
  verifyCodeSchema,
  resetSchema,
  resendVerifySchema,
  changePasswordSchema,
  settingsSchema,
  categoryAddSchema,
  categoryRenameSchema,
  categoryDeleteSchema,
  parseCategoryPayload
} = require('./utils/validation');

const app = express();
const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const isProduction = process.env.NODE_ENV === 'production';
const APP_BASE_URL = (process.env.APP_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const APP_IS_HTTPS = APP_BASE_URL.startsWith('https://');

const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) {
  console.warn('⚠️  SESSION_SECRET 未设置，当前使用临时密钥，重启后会失效。');
}
if (isProduction && !APP_IS_HTTPS) {
  console.warn('⚠️  NODE_ENV=production 但 APP_BASE_URL 不是 https，将使用非 secure cookie（适用于本地直连）。');
}

app.set('view engine', 'ejs');
app.set('views', path.resolve(__dirname, '../views'));
app.set('trust proxy', true);
app.use(compression());
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"]
      }
    }
  })
);
app.use(express.urlencoded({ extended: false, limit: '20kb' }));
app.use(express.json({ limit: '20kb' }));
app.use('/public', express.static(path.resolve(__dirname, '../public')));
app.use(
  session({
    name: 'subtier.sid',
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    store: new FileSessionStore(),
    cookie: {
      httpOnly: true,
      secure: APP_IS_HTTPS,
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 8
    }
  })
);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
  message: '登录尝试过多，请稍后再试'
});

const mailIpLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 4,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
  message: '邮件发送过于频繁，请 1 分钟后重试'
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
  handler: (req, res) => {
    const reset = req.rateLimit && req.rateLimit.resetTime;
    const retryAfter = reset ? Math.max(1, Math.ceil((reset.getTime() - Date.now()) / 1000)) : 60;
    res.setHeader('Retry-After', String(retryAfter));
    res.status(429).json({ error: 'rate_limited', message: `too many requests, retry after ${retryAfter} seconds` });
  }
});

function apiCors(req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
}

app.use('/api/v1', apiCors, apiLimiter, require('./routes/api'));

const csrfProtection = csurf();
app.use(csrfProtection);

app.use(async (req, res, next) => {
  res.locals.csrfToken = req.csrfToken();
  res.locals.currentUser = req.session.user || null;
  res.locals.error = null;
  res.locals.flash = req.session.flash || null;
  if (req.session.flash) delete req.session.flash;
  try {
    const settings = await getSettings();
    res.locals.publicSettings = {
      registrationEnabled: settings.registrationEnabled,
      oauthEnabled: settings.oauthEnabled,
      microsoftReady: await isMicrosoftEnabled()
    };
  } catch {
    res.locals.publicSettings = { registrationEnabled: false, oauthEnabled: false, microsoftReady: false };
  }
  next();
});

function setFlash(req, payload) {
  req.session.flash = payload;
}

function isAdminOrAbove(user) {
  return user && (user.role === 'Admin' || user.role === 'SuperAdmin');
}

function publicUser(user) {
  return { id: user.id, username: user.username, email: user.email, role: user.role };
}

function normalizeMicrosoftUsername(displayName, subject) {
  const raw = String(displayName || '').trim();
  const cleaned = raw.replace(/\s+/g, '_').replace(/[^A-Za-z0-9_-]/g, '_');
  const trimmed = cleaned.replace(/^_+|_+$/g, '');
  const fallback = `ms_${String(subject || 'user').slice(0, 8)}`;
  const base = trimmed.length >= 3 ? trimmed : fallback;
  return base.slice(0, 32);
}

async function ensureUniqueUsername(base) {
  if (!(await findUserByUsername(base))) return base;
  for (let i = 1; ; i += 1) {
    const suffix = `_${i}`;
    const trimmed = base.slice(0, 32 - suffix.length);
    const candidate = `${trimmed}${suffix}`;
    if (!(await findUserByUsername(candidate))) return candidate;
  }
}

function summariseEntries(entries) {
  const sorted = [...entries].sort((a, b) => a.position - b.position);
  const categories = Array.from(new Set(entries.flatMap((e) => Object.keys(e.categories || {})))).sort((a, b) => a.localeCompare(b));
  return { sorted, categories };
}

// ---------- Public ----------

app.get('/', async (req, res, next) => {
  try {
    const entries = await getLeaderboard();
    const { sorted, categories } = summariseEntries(entries);
    res.render('index', {
      title: "CNTiers",
      entries: sorted,
      categories,
      stats: { totalPlayers: entries.length, totalCategories: categories.length }
    });
  } catch (error) { next(error); }
});

app.get('/api/docs', (req, res) => {
  const proto = req.protocol;
  const host = req.get('host');
  const baseUrl = `${proto}://${host}`;
  res.render('api-docs', { title: 'API 文档', baseUrl });
});

// ---------- Auth: login ----------

app.get('/admin/login', (req, res) => res.redirect('/login'));

app.get('/login', async (req, res) => {
  if (req.session.user) return res.redirect(isAdminOrAbove(req.session.user) ? '/admin' : '/');
  res.render('login', { title: '登录', error: null, identifier: '' });
});

app.post('/login', loginLimiter, async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).render('login', { title: '登录', error: '账号或密码格式不正确', identifier: req.body.identifier || '' });
  }
  const { identifier, password } = parsed.data;
  const user = identifier.includes('@')
    ? await findUserByEmail(identifier)
    : await findUserByUsername(identifier);
  if (!user || !user.passwordHash) {
    return res.status(401).render('login', { title: '登录', error: '账号或密码错误', identifier });
  }
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    return res.status(401).render('login', { title: '登录', error: '账号或密码错误', identifier });
  }
  if (!user.emailVerified && user.role !== 'SuperAdmin') {
    return res.status(403).render('login', {
      title: '登录',
      error: '邮箱尚未验证。请到验证码页面输入收到的验证码完成验证。',
      identifier
    });
  }
  req.session.regenerate((err) => {
    if (err) return res.status(500).render('login', { title: '登录', error: '登录失败，请稍后重试', identifier });
    req.session.user = publicUser(user);
    res.redirect(isAdminOrAbove(user) ? '/admin' : '/');
  });
});

app.post('/logout', requireAuth, (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('subtier.sid');
    res.redirect('/');
  });
});
app.post('/admin/logout', requireAuth, (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('subtier.sid');
    res.redirect('/');
  });
});

// ---------- Auth: register + verify ----------

app.get('/register', async (req, res) => {
  const settings = await getSettings();
  if (!settings.registrationEnabled) {
    return res.status(404).render('error', { title: '注册未开放', message: '管理员当前未开放注册' });
  }
  res.render('register', { title: '注册', error: null, values: { username: '', email: '' } });
});

app.post('/register', mailIpLimiter, async (req, res) => {
  const settings = await getSettings();
  if (!settings.registrationEnabled) {
    return res.status(404).render('error', { title: '注册未开放', message: '管理员当前未开放注册' });
  }
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return res.status(400).render('register', {
      title: '注册',
      error: issue ? issue.message : '表单格式不正确',
      values: { username: req.body.username || '', email: req.body.email || '' }
    });
  }
  const { username, email, password } = parsed.data;

  if (await findUserByUsername(username)) {
    return res.status(409).render('register', { title: '注册', error: '该用户名已被占用', values: { username, email } });
  }
  if (await findUserByEmail(email)) {
    return res.status(409).render('register', { title: '注册', error: '该邮箱已注册', values: { username, email } });
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const code = generateCode();
  const verifyExpires = new Date(Date.now() + VERIFY_TTL_MS).toISOString();
  const newUser = {
    id: `user-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
    username,
    email,
    passwordHash,
    role: 'User',
    emailVerified: false,
    verifyToken: code,
    verifyExpires,
    verifyAttempts: 0,
    passwordResetToken: null,
    passwordResetExpires: null,
    resetAttempts: 0,
    oauthProvider: null,
    oauthSubject: null,
    mailCooldown: { verify: new Date().toISOString() },
    createdAt: new Date().toISOString()
  };

  try {
    await sendVerificationCode({ to: email, code, recipientName: username });
  } catch (error) {
    console.error('发送验证邮件失败:', error.message);
    return res.status(502).render('register', {
      title: '注册',
      error: '邮件发送失败，请联系管理员',
      values: { username, email }
    });
  }

  await upsertUser(newUser);
  res.redirect(`/verify?email=${encodeURIComponent(email)}`);
});

app.get('/verify', (req, res) => {
  const email = String(req.query.email || '');
  res.render('verify', { title: '邮箱验证', error: null, success: null, email });
});

app.post('/verify', async (req, res) => {
  const parsed = verifyCodeSchema.safeParse(req.body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return res.status(400).render('verify', {
      title: '邮箱验证',
      error: issue ? issue.message : '请输入正确的邮箱和 6 位验证码',
      success: null,
      email: req.body.email || ''
    });
  }
  const { email, code } = parsed.data;
  const user = await findUserByEmail(email);
  if (!user || user.emailVerified) {
    return res.status(400).render('verify', { title: '邮箱验证', error: '验证失败：账号不存在或已验证', success: null, email });
  }
  if (!user.verifyToken || !user.verifyExpires || new Date(user.verifyExpires).getTime() < Date.now()) {
    return res.status(400).render('verify', { title: '邮箱验证', error: '验证码已过期，请点击下方"重新发送"获取新的验证码', success: null, email });
  }
  if (!timingSafeEqualString(user.verifyToken, code)) {
    const attempts = (user.verifyAttempts || 0) + 1;
    if (attempts >= MAX_CODE_ATTEMPTS) {
      await upsertUser({ ...user, verifyToken: null, verifyExpires: null, verifyAttempts: 0 });
      return res.status(400).render('verify', { title: '邮箱验证', error: '错误次数过多，当前验证码已作废，请点击"重新发送"获取新验证码', success: null, email });
    }
    await upsertUser({ ...user, verifyAttempts: attempts });
    const left = MAX_CODE_ATTEMPTS - attempts;
    return res.status(400).render('verify', { title: '邮箱验证', error: `验证码不正确，还有 ${left} 次尝试机会`, success: null, email });
  }
  await upsertUser({ ...user, emailVerified: true, verifyToken: null, verifyExpires: null, verifyAttempts: 0 });
  setFlash(req, { kind: 'success', text: '邮箱验证成功，请用账号 / 邮箱 + 密码登录' });
  res.redirect('/login');
});

app.post('/resend-verification', mailIpLimiter, async (req, res) => {
  const parsed = resendVerifySchema.safeParse(req.body);
  const email = parsed.success ? parsed.data.email : String(req.body.email || '');
  if (!parsed.success) {
    return res.status(400).render('verify', { title: '邮箱验证', error: '邮箱格式不正确', success: null, email });
  }
  const user = await findUserByEmail(email);
  const successText = '如果该邮箱存在且尚未验证，我们已发送一封新的验证码邮件（5 分钟内有效）';

  if (user && !user.emailVerified) {
    if (!isCooledDown(user, 'verify')) {
      const wait = remainingCooldownSeconds(user, 'verify');
      return res.status(429).render('verify', {
        title: '邮箱验证',
        error: `请 ${wait} 秒后重试（每次发送之间需要 30 秒冷却）`,
        success: null,
        email
      });
    }
    const code = generateCode();
    const verifyExpires = new Date(Date.now() + VERIFY_TTL_MS).toISOString();
    try {
      await sendVerificationCode({ to: user.email, code, recipientName: user.username });
    } catch (error) {
      console.error('重发验证邮件失败:', error.message);
      return res.status(502).render('verify', { title: '邮箱验证', error: '邮件发送失败，请稍后重试', success: null, email });
    }
    await stampMailSent(user, 'verify', { verifyToken: code, verifyExpires, verifyAttempts: 0 });
  }

  res.render('verify', { title: '邮箱验证', error: null, success: successText, email });
});

// ---------- Auth: forgot / reset password (code-based) ----------

app.get('/forgot', (req, res) => {
  res.render('forgot', { title: '忘记密码', error: null, success: null, email: '' });
});

app.post('/forgot', mailIpLimiter, async (req, res) => {
  const parsed = forgotSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).render('forgot', { title: '忘记密码', error: '邮箱格式不正确', success: null, email: req.body.email || '' });
  }
  const { email } = parsed.data;
  const user = await findUserByEmail(email);

  if (user && user.passwordHash && user.role !== 'SuperAdmin') {
    if (!isCooledDown(user, 'reset')) {
      const wait = remainingCooldownSeconds(user, 'reset');
      return res.status(429).render('forgot', {
        title: '忘记密码',
        error: `请 ${wait} 秒后重试（每次发送之间需要 30 秒冷却）`,
        success: null,
        email
      });
    }
    const code = generateCode();
    try {
      await sendPasswordResetCode({ to: user.email, code, recipientName: user.username });
    } catch (error) {
      console.error('发送重置邮件失败:', error.message);
      return res.status(502).render('forgot', { title: '忘记密码', error: '邮件发送失败，请稍后重试', success: null, email });
    }
    await stampMailSent(user, 'reset', {
      passwordResetToken: code,
      passwordResetExpires: new Date(Date.now() + RESET_TTL_MS).toISOString(),
      resetAttempts: 0
    });
  }

  // Always redirect to /reset so the user has the form ready, regardless of whether the email exists.
  res.redirect(`/reset?email=${encodeURIComponent(email)}`);
});

app.get('/reset', (req, res) => {
  const email = String(req.query.email || '');
  res.render('reset', { title: '重置密码', error: null, success: null, email });
});

app.post('/reset', async (req, res) => {
  const parsed = resetSchema.safeParse(req.body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return res.status(400).render('reset', {
      title: '重置密码',
      error: issue ? issue.message : '表单格式不正确',
      success: null,
      email: req.body.email || ''
    });
  }
  const { email, code, password } = parsed.data;
  const user = await findUserByEmail(email);
  if (!user || !user.passwordHash) {
    return res.status(400).render('reset', { title: '重置密码', error: '验证码不正确或已过期', success: null, email });
  }
  if (!user.passwordResetToken || !user.passwordResetExpires || new Date(user.passwordResetExpires).getTime() < Date.now()) {
    return res.status(400).render('reset', { title: '重置密码', error: '验证码已过期，请回到「忘记密码」重新发送', success: null, email });
  }
  if (!timingSafeEqualString(user.passwordResetToken, code)) {
    const attempts = (user.resetAttempts || 0) + 1;
    if (attempts >= MAX_CODE_ATTEMPTS) {
      await upsertUser({ ...user, passwordResetToken: null, passwordResetExpires: null, resetAttempts: 0 });
      return res.status(400).render('reset', { title: '重置密码', error: '错误次数过多，当前验证码已作废，请回到「忘记密码」重新发送', success: null, email });
    }
    await upsertUser({ ...user, resetAttempts: attempts });
    const left = MAX_CODE_ATTEMPTS - attempts;
    return res.status(400).render('reset', { title: '重置密码', error: `验证码不正确，还有 ${left} 次尝试机会`, success: null, email });
  }
  const passwordHash = await bcrypt.hash(password, 12);
  await upsertUser({
    ...user,
    passwordHash,
    passwordResetToken: null,
    passwordResetExpires: null,
    resetAttempts: 0,
    emailVerified: true
  });
  setFlash(req, { kind: 'success', text: '密码已重置，请使用新密码登录' });
  res.redirect('/login');
});

// ---------- Auth: Microsoft OAuth (login flow) ----------

app.get('/auth/microsoft', async (req, res, next) => {
  try {
    if (!(await isMicrosoftEnabled())) {
      return res.status(404).render('error', { title: 'OAuth 未启用', message: '管理员未开启 Microsoft 登录或未配置凭据' });
    }
    const { url, state, verifier, redirectUri } = await buildAuthUrl({ baseUrl: APP_BASE_URL, mode: 'login' });
    req.session.oauthState = { state, verifier, redirectUri, mode: 'login', createdAt: Date.now() };
    res.redirect(url);
  } catch (error) { next(error); }
});

app.get('/auth/microsoft/callback', async (req, res, next) => {
  try {
    if (!(await isMicrosoftEnabled())) {
      return res.status(404).render('error', { title: 'OAuth 未启用', message: '管理员未开启 Microsoft 登录' });
    }
    const stash = req.session.oauthState;
    delete req.session.oauthState;
    const code = String(req.query.code || '');
    const state = String(req.query.state || '');
    if (!stash || stash.mode !== 'login' || !code || !state || !timingSafeEqualString(stash.state, state)) {
      return res.status(400).render('error', { title: '回调验证失败', message: 'OAuth state 无效，请重试' });
    }
    if (Date.now() - stash.createdAt > 10 * 60 * 1000) {
      return res.status(400).render('error', { title: '回调超时', message: '请求已过期，请重试' });
    }

    const tokens = await exchangeCode({ code, verifier: stash.verifier, redirectUri: stash.redirectUri });
    const profile = await fetchProfile(tokens.access_token);
    if (!profile.email) {
      return res.status(400).render('error', { title: '账号缺少邮箱', message: '该 Microsoft 账号未提供邮箱信息' });
    }

    let user = await findUserByOauth('microsoft', profile.subject);
    if (!user) {
      user = await findUserByEmail(profile.email);
      if (user && user.oauthSubject && user.oauthSubject !== profile.subject) {
        return res.status(403).render('error', {
          title: '账号已绑定',
          message: '该邮箱已绑定其他 Microsoft 账号，请使用已绑定的账号登录'
        });
      }
    }
    if (!user) {
      const baseUsername = normalizeMicrosoftUsername(profile.displayName, profile.subject);
      const username = await ensureUniqueUsername(baseUsername);
      user = await upsertUser({
        id: `user-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
        username,
        email: profile.email,
        passwordHash: null,
        role: 'User',
        emailVerified: true,
        verifyToken: null,
        verifyExpires: null,
        passwordResetToken: null,
        passwordResetExpires: null,
        oauthProvider: 'microsoft',
        oauthSubject: profile.subject,
        mailCooldown: {},
        createdAt: new Date().toISOString()
      });
    } else if (!user.oauthSubject) {
      user = await upsertUser({ ...user, oauthProvider: 'microsoft', oauthSubject: profile.subject, emailVerified: true });
    }

    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.user = publicUser(user);
      res.redirect(isAdminOrAbove(user) ? '/admin' : '/');
    });
  } catch (error) { next(error); }
});

// ---------- Account: profile + Microsoft link/unlink (logged-in user) ----------

app.get('/account', requireAuth, async (req, res, next) => {
  try {
    const user = await findUserById(req.session.user.id);
    if (!user) {
      req.session.destroy(() => res.redirect('/login'));
      return;
    }
    res.render('account', {
      title: '账户',
      user,
      microsoftReady: await isMicrosoftEnabled(),
      flashError: req.query.error || null,
      flashSuccess: req.query.success || null
    });
  } catch (error) { next(error); }
});

app.get('/account/link/microsoft', requireAuth, async (req, res, next) => {
  try {
    if (!(await isMicrosoftEnabled())) {
      return res.redirect('/account?error=oauth_disabled');
    }
    const user = await findUserById(req.session.user.id);
    if (user && user.oauthSubject) {
      return res.redirect('/account?error=already_linked');
    }
    const { url, state, verifier, redirectUri } = await buildAuthUrl({ baseUrl: APP_BASE_URL, mode: 'link' });
    req.session.oauthState = { state, verifier, redirectUri, mode: 'link', createdAt: Date.now() };
    res.redirect(url);
  } catch (error) { next(error); }
});

app.get('/account/link/microsoft/callback', requireAuth, async (req, res, next) => {
  try {
    if (!(await isMicrosoftEnabled())) {
      return res.redirect('/account?error=oauth_disabled');
    }
    const stash = req.session.oauthState;
    delete req.session.oauthState;
    const code = String(req.query.code || '');
    const state = String(req.query.state || '');
    if (!stash || stash.mode !== 'link' || !code || !state || !timingSafeEqualString(stash.state, state)) {
      return res.redirect('/account?error=state_invalid');
    }
    if (Date.now() - stash.createdAt > 10 * 60 * 1000) {
      return res.redirect('/account?error=expired');
    }
    const tokens = await exchangeCode({ code, verifier: stash.verifier, redirectUri: stash.redirectUri });
    const profile = await fetchProfile(tokens.access_token);
    if (!profile.subject) {
      return res.redirect('/account?error=no_subject');
    }

    const otherUser = await findUserByOauth('microsoft', profile.subject);
    if (otherUser && otherUser.id !== req.session.user.id) {
      return res.redirect('/account?error=subject_taken');
    }

    const me = await findUserById(req.session.user.id);
    if (!me) {
      req.session.destroy(() => res.redirect('/login'));
      return;
    }
    await upsertUser({
      ...me,
      oauthProvider: 'microsoft',
      oauthSubject: profile.subject,
      emailVerified: true
    });
    res.redirect('/account?success=linked');
  } catch (error) { next(error); }
});

app.post('/account/unlink/microsoft', requireAuth, async (req, res, next) => {
  try {
    const me = await findUserById(req.session.user.id);
    if (!me) {
      req.session.destroy(() => res.redirect('/login'));
      return;
    }
    if (!me.oauthSubject) return res.redirect('/account?error=not_linked');
    if (!me.passwordHash) return res.redirect('/account?error=needs_password');
    await upsertUser({ ...me, oauthProvider: null, oauthSubject: null });
    res.redirect('/account?success=unlinked');
  } catch (error) { next(error); }
});

app.post('/account/password', requireAuth, async (req, res, next) => {
  try {
    const parsed = changePasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const code = issue && issue.path && issue.path[0] === 'passwordConfirm' ? 'mismatch' : 'invalid';
      return res.redirect(`/account?error=${code}`);
    }
    const me = await findUserById(req.session.user.id);
    if (!me) {
      req.session.destroy(() => res.redirect('/login'));
      return;
    }
    if (me.passwordHash) {
      if (!parsed.data.currentPassword) return res.redirect('/account?error=current_required');
      const ok = await bcrypt.compare(parsed.data.currentPassword, me.passwordHash);
      if (!ok) return res.redirect('/account?error=current_wrong');
    }
    const passwordHash = await bcrypt.hash(parsed.data.password, 12);
    await upsertUser({
      ...me,
      passwordHash,
      passwordResetToken: null,
      passwordResetExpires: null
    });
    res.redirect('/account?success=password_changed');
  } catch (error) { next(error); }
});

// ---------- Admin: dashboard ----------

app.get('/admin', requireAdminOrAbove, async (req, res, next) => {
  try {
    const entries = await getLeaderboard();
    const { sorted, categories } = summariseEntries(entries);
    const successMap = { created: '条目已添加', updated: '条目已保存', deleted: '条目已删除', quick: '已更新' };
    const errorMap = {
      invalid_form: '表单格式不正确，请检查后重试',
      not_found: '目标条目不存在，可能已被删除',
      invalid_request: '请求参数无效，请刷新后重试'
    };

    const success = typeof req.query.success === 'string' ? req.query.success : '';
    const errorKey = typeof req.query.error === 'string' ? req.query.error : '';
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(5, parseInt(req.query.limit, 10) || 20));
    const totalEntries = entries.length;
    const totalPages = Math.max(1, Math.ceil(totalEntries / limit));
    const offset = (page - 1) * limit;
    const pagedEntries = sorted.slice(offset, offset + limit);

    res.render('admin/dashboard', {
      title: '后台管理',
      entries: pagedEntries,
      page,
      totalPages,
      totalEntries,
      categoryKeys: categories,
      successMessage: successMap[success] || null,
      errorMessage: errorMap[errorKey] || null
    });
  } catch (error) { next(error); }
});

app.get('/admin/export', requireAdminOrAbove, async (req, res, next) => {
  try {
    const entries = await getLeaderboard();
    const { sorted, categories } = summariseEntries(entries);
    const headers = ['排名', '玩家', '段位', '积分', '测试服务器', ...categories];
    const rows = sorted.map((entry) => {
      const cats = categories.map((k) => entry.categories?.[k] || '');
      return [entry.position, entry.player, entry.rank, entry.points, entry.testServer || '', ...cats];
    });
    const escapeCell = (v) => {
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [headers, ...rows].map((r) => r.map(escapeCell).join(',')).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="leaderboard.csv"');
    res.send('﻿' + csv);
  } catch (error) { next(error); }
});

// ---------- Admin: entries ----------

app.post('/admin/entries', requireAdminOrAbove, async (req, res) => {
  const parsed = leaderboardSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).redirect('/admin?error=invalid_form');
  const categories = parseCategoryPayload(req.body);
  const entries = await getLeaderboard();
  entries.push({
    id: `entry-${Date.now()}`,
    player: parsed.data.player,
    rank: parsed.data.rank,
    points: parsed.data.points,
    testServer: parsed.data.testServer || null,
    categories,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  await saveLeaderboard(entries);
  res.redirect('/admin?success=created');
});

app.post('/admin/entries/:id/update', requireAdminOrAbove, async (req, res) => {
  const idSchema = z.object({ id: z.string().min(1).max(64) });
  const validParams = idSchema.safeParse(req.params);
  const parsed = leaderboardSchema.safeParse(req.body);
  if (!validParams.success || !parsed.success) return res.status(400).redirect('/admin?error=invalid_form');
  const categories = parseCategoryPayload(req.body);
  const entries = await getLeaderboard();
  const idx = entries.findIndex((e) => e.id === validParams.data.id);
  if (idx === -1) return res.status(404).redirect('/admin?error=not_found');
  entries[idx] = {
    ...entries[idx],
    player: parsed.data.player,
    rank: parsed.data.rank,
    points: parsed.data.points,
    testServer: parsed.data.testServer || null,
    categories,
    updatedAt: new Date().toISOString()
  };
  await saveLeaderboard(entries);
  res.redirect('/admin?success=updated');
});

app.post('/admin/entries/:id/quick', requireAdminOrAbove, async (req, res) => {
  const idSchema = z.object({ id: z.string().min(1).max(64) });
  const validParams = idSchema.safeParse(req.params);
  const parsed = quickEditSchema.safeParse(req.body);
  if (!validParams.success || !parsed.success) return res.status(400).redirect('/admin?error=invalid_form');
  const entries = await getLeaderboard();
  const idx = entries.findIndex((e) => e.id === validParams.data.id);
  if (idx === -1) return res.status(404).redirect('/admin?error=not_found');
  const patch = {};
  if (parsed.data.points !== undefined) patch.points = parsed.data.points;
  if (parsed.data.rank !== undefined) patch.rank = parsed.data.rank;
  if (parsed.data.testServer !== undefined) patch.testServer = parsed.data.testServer;
  entries[idx] = { ...entries[idx], ...patch, updatedAt: new Date().toISOString() };
  await saveLeaderboard(entries);
  res.redirect('/admin?success=quick');
});

app.post('/admin/entries/:id/delete', requireAdminOrAbove, async (req, res) => {
  const idSchema = z.object({ id: z.string().min(1).max(64) });
  const validParams = idSchema.safeParse(req.params);
  if (!validParams.success) return res.status(400).redirect('/admin?error=invalid_request');
  const entries = await getLeaderboard();
  const next = entries.filter((e) => e.id !== validParams.data.id);
  await saveLeaderboard(next);
  res.redirect('/admin?success=deleted');
});

// ---------- Admin: categories ----------

app.get('/admin/categories', requireAdminOrAbove, async (req, res, next) => {
  try {
    const categories = await listCategories();
    res.render('admin/categories', {
      title: '细分项目',
      categories,
      flashError: req.query.error || null,
      flashSuccess: req.query.success || null
    });
  } catch (error) { next(error); }
});

app.post('/admin/categories/add', requireAdminOrAbove, async (req, res) => {
  const parsed = categoryAddSchema.safeParse(req.body);
  if (!parsed.success) return res.redirect('/admin/categories?error=invalid');
  try {
    await addCategory(parsed.data.name);
    res.redirect('/admin/categories?success=added');
  } catch (error) {
    res.redirect(`/admin/categories?error=${encodeURIComponent(error.code || 'unknown')}`);
  }
});

app.post('/admin/categories/rename', requireAdminOrAbove, async (req, res) => {
  const parsed = categoryRenameSchema.safeParse(req.body);
  if (!parsed.success) return res.redirect('/admin/categories?error=invalid');
  try {
    await renameCategory(parsed.data.from, parsed.data.to);
    res.redirect('/admin/categories?success=renamed');
  } catch (error) {
    res.redirect(`/admin/categories?error=${encodeURIComponent(error.code || 'unknown')}`);
  }
});

app.post('/admin/categories/delete', requireAdminOrAbove, async (req, res) => {
  const parsed = categoryDeleteSchema.safeParse(req.body);
  if (!parsed.success) return res.redirect('/admin/categories?error=invalid');
  try {
    await deleteCategory(parsed.data.name);
    res.redirect('/admin/categories?success=deleted');
  } catch (error) {
    res.redirect(`/admin/categories?error=${encodeURIComponent(error.code || 'unknown')}`);
  }
});

// ---------- Admin: settings (SuperAdmin) ----------

app.get('/admin/settings', requireSuperAdmin, async (req, res, next) => {
  try {
    const settings = await getSettings();
    res.render('admin/settings', {
      title: '站点设置',
      settings,
      microsoftReady: await isMicrosoftEnabled(),
      flashError: req.query.error || null,
      flashSuccess: req.query.success || null
    });
  } catch (error) { next(error); }
});

app.post('/admin/settings', requireSuperAdmin, async (req, res, next) => {
  try {
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success) return res.redirect('/admin/settings?error=invalid');
    await saveSettings({
      registrationEnabled: !!parsed.data.registrationEnabled,
      oauthEnabled: !!parsed.data.oauthEnabled,
      oauthMicrosoft: {
        clientId: parsed.data.oauthClientId || '',
        tenant: parsed.data.oauthTenant || 'common'
      }
    });
    res.redirect('/admin/settings?success=saved');
  } catch (error) { next(error); }
});

// ---------- Admin: users (SuperAdmin) ----------

app.get('/admin/users', requireSuperAdmin, async (req, res, next) => {
  try {
    const users = await getUsers();
    const sorted = [...users].sort((a, b) => {
      const order = { SuperAdmin: 0, Admin: 1, User: 2 };
      const cmp = (order[a.role] ?? 99) - (order[b.role] ?? 99);
      if (cmp !== 0) return cmp;
      return (a.username || '').localeCompare(b.username || '');
    });
    res.render('admin/users', {
      title: '用户管理',
      users: sorted,
      flashError: req.query.error || null,
      flashSuccess: req.query.success || null
    });
  } catch (error) { next(error); }
});

async function changeUserRole(id, nextRole, currentUser) {
  const target = await findUserById(id);
  if (!target) throw Object.assign(new Error('not_found'), { code: 'not_found' });
  if (target.role === 'SuperAdmin' || target.username === SUPER_ADMIN_USERNAME) {
    throw Object.assign(new Error('cannot_modify_super'), { code: 'cannot_modify_super' });
  }
  if (target.id === currentUser.id) {
    throw Object.assign(new Error('cannot_modify_self'), { code: 'cannot_modify_self' });
  }
  await upsertUser({ ...target, role: nextRole });
}

app.post('/admin/users/:id/promote', requireSuperAdmin, async (req, res) => {
  try {
    await changeUserRole(req.params.id, 'Admin', req.session.user);
    res.redirect('/admin/users?success=promoted');
  } catch (error) {
    res.redirect(`/admin/users?error=${encodeURIComponent(error.code || 'unknown')}`);
  }
});

app.post('/admin/users/:id/demote', requireSuperAdmin, async (req, res) => {
  try {
    await changeUserRole(req.params.id, 'User', req.session.user);
    res.redirect('/admin/users?success=demoted');
  } catch (error) {
    res.redirect(`/admin/users?error=${encodeURIComponent(error.code || 'unknown')}`);
  }
});

app.post('/admin/users/:id/delete', requireSuperAdmin, async (req, res) => {
  try {
    const target = await findUserById(req.params.id);
    if (!target) return res.redirect('/admin/users?error=not_found');
    if (target.role === 'SuperAdmin' || target.username === SUPER_ADMIN_USERNAME) {
      return res.redirect('/admin/users?error=cannot_modify_super');
    }
    if (target.id === req.session.user.id) {
      return res.redirect('/admin/users?error=cannot_modify_self');
    }
    await removeUser(target.id);
    res.redirect('/admin/users?success=deleted');
  } catch {
    res.redirect('/admin/users?error=unknown');
  }
});

// ---------- 404 + error handlers ----------

function fillErrorLocals(req, res) {
  if (typeof res.locals.currentUser === 'undefined') {
    res.locals.currentUser = (req.session && req.session.user) || null;
  }
  if (typeof res.locals.flash === 'undefined') res.locals.flash = null;
  if (typeof res.locals.publicSettings === 'undefined') {
    res.locals.publicSettings = { registrationEnabled: false, oauthEnabled: false, microsoftReady: false };
  }
  if (typeof res.locals.csrfToken !== 'string') {
    try { res.locals.csrfToken = req.csrfToken ? req.csrfToken() : ''; }
    catch { res.locals.csrfToken = ''; }
  }
}

app.use((req, res) => {
  fillErrorLocals(req, res);
  res.status(404).render('error', { title: '页面未找到', message: '你访问的页面不存在' });
});

app.use((error, req, res, next) => {
  fillErrorLocals(req, res);
  if (error.code === 'EBADCSRFTOKEN') {
    return res.status(403).render('error', {
      title: '安全校验失败',
      message: '页面上的安全令牌已过期或与当前会话不匹配，请按 Ctrl+Shift+R 强制刷新页面后重试。'
    });
  }
  console.error(error);
  res.status(500).render('error', { title: '服务器错误', message: '应用内部错误，请稍后重试' });
});

// ---------- Bootstrap ----------

async function bootstrap() {
  await ensureDataDir();
  await getSettings();
  await getUsers();
  await importExcelIfNeeded();
  await ensureRequiredRenames();

  const server = app.listen(PORT, () => {
    console.log(`SubtierWebsite started on http://localhost:${PORT}`);
  });

  // Cloudflare Tunnel 默认连接池 idle ~90s；Node 默认 keepAliveTimeout 5s 会让 cloudflared
  // 复用一条 Node 已半关的连接 → ECONNRESET → 502。两值都必须 > 上游 idle，且 headersTimeout > keepAliveTimeout。
  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 125_000;

  function shutdown(signal) {
    console.log(`收到 ${signal}，开始优雅关闭`);
    server.close((err) => {
      if (err) {
        console.error('关闭 HTTP 服务出错:', err);
        process.exit(1);
      }
      process.exit(0);
    });
    setTimeout(() => {
      console.warn('优雅关闭超时，强制退出');
      process.exit(1);
    }, 5_000).unref();
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection:', reason);
});

bootstrap().catch((error) => {
  console.error('应用启动失败:', error);
  process.exit(1);
});
