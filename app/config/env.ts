import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import 'dotenv/config';
import { z } from 'zod';

/**
 * 环境变量在进程启动时一次性校验并冻结。其余模块一律从这里读取，
 * 不再直接碰 process.env（由 eslint no-restricted-properties 强制）。
 */

const trimmed = z.string().transform((value) => value.trim());
const optionalText = trimmed.optional();

const httpUrl = trimmed.refine(
  (value) => value.startsWith('http://') || value.startsWith('https://'),
  { message: '必须是以 http:// 或 https:// 开头的绝对 URL' }
);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  APP_BASE_URL: httpUrl.optional(),

  SESSION_SECRET: optionalText,

  ADMIN_USERNAME: trimmed.default('admin'),
  ADMIN_PASSWORD: trimmed.default('ChangeMe_12345'),

  RESEND_API_KEY: optionalText,
  EMAIL_FROM: optionalText,

  MS_OAUTH_CLIENT_ID: optionalText,
  MS_OAUTH_CLIENT_SECRET: optionalText,
  // 不给默认值：'common' 与「没设置」必须可区分，否则 settingsService 分不清
  // 「运维要求接受任意租户」和「运维压根没配」，兜底逻辑也就无从谈起
  MS_OAUTH_TENANT: optionalText,

  DATA_DIR: optionalText,
  FORCE_SQLITE: optionalText
});

type RawEnv = z.infer<typeof envSchema>;

function parseEnv(): RawEnv {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    console.error(`✖ 环境变量校验失败：\n${issues}\n请对照 .env.example 检查 .env。`);
    process.exit(1);
  }
  return result.data;
}

const raw = parseEnv();

const isProduction = raw.NODE_ENV === 'production';
const isTest = raw.NODE_ENV === 'test';

/**
 * 生产环境的必填项一次性全部检查完再退出。
 *
 * 逐项 exit 会让运维「补一个、重启、再看下一个」地来回好几轮——zod 的分支
 * 是聚合报错的，手写的这两条也该一致。
 *
 * 校验只在 isProduction 分支做，不写进 zod schema：写进 schema 会让 dev 与
 * test 每次 import 都退出。
 */
/**
 * 生产环境下 SESSION_SECRET 的最低长度。
 *
 * 它同时是会话签名密钥与验证码 HMAC 的 HKDF 输入材料，短口令意味着这两件事
 * 一起可爆破。文档里给的生成命令产出 64 个十六进制字符，32 只是下限。
 */
const MIN_SESSION_SECRET_LENGTH = 32;

const SECRET_HINT =
  "    生成方式：node -e \"console.log(require('node:crypto').randomBytes(32).toString('hex'))\"";

function assertProductionEnv(): void {
  if (!isProduction) return;

  const missing: string[] = [];
  if (!raw.SESSION_SECRET || raw.SESSION_SECRET.length === 0) {
    missing.push(
      '  - SESSION_SECRET：同时用于会话签名与验证码 HMAC 派生，缺失会导致重启后会话与验证码全部失效。\n' +
        SECRET_HINT
    );
  } else if (raw.SESSION_SECRET.length < MIN_SESSION_SECRET_LENGTH) {
    missing.push(
      `  - SESSION_SECRET：至少需要 ${String(MIN_SESSION_SECRET_LENGTH)} 个字符，当前只有 ` +
        `${String(raw.SESSION_SECRET.length)} 个。它既是会话签名密钥，也是验证码 HMAC 的派生材料，` +
        '短口令等于这两件事一起可爆破。\n' +
        SECRET_HINT
    );
  }
  if (!raw.APP_BASE_URL) {
    /*
     * 缺失时退回 http://localhost:PORT 的后果不是「地址不对」这么轻：isHttps 会
     * 变成 false，于是会话 cookie 丢掉 Secure、CSP 丢掉 upgrade-insecure-requests，
     * OAuth 的 redirect_uri 也会拼错。三件事都是静默发生的。
     */
    missing.push(
      '  - APP_BASE_URL：决定会话 cookie 是否带 Secure、CSP 是否升级不安全请求，' +
        '以及 Microsoft OAuth 的 redirect_uri。\n' +
        '    例：APP_BASE_URL=https://subtier.example.com'
    );
  }

  if (missing.length > 0) {
    console.error(`✖ 生产环境缺少必需的环境变量：\n${missing.join('\n')}`);
    process.exit(1);
  }
}

assertProductionEnv();

function resolveSessionSecret(): string {
  if (raw.SESSION_SECRET && raw.SESSION_SECRET.length > 0) return raw.SESSION_SECRET;
  const temporary = randomBytes(32).toString('hex');
  if (!isTest) {
    console.warn('⚠️  SESSION_SECRET 未设置，本次运行使用临时密钥，重启后会话会失效。');
  }
  return temporary;
}

const port = raw.PORT;
const appBaseUrl = (raw.APP_BASE_URL ?? `http://localhost:${raw.PORT}`).replace(/\/+$/, '');

/*
 * 生产环境用 http:// 是合法的（本机直连、内网），但它同样会静默关掉 Secure
 * cookie 与 upgrade-insecure-requests，所以必须说出来。旧站 src/server.js 有
 * 这条告警，重写时丢了——对最容易发生的误配置而言那是个退步。
 */
if (isProduction && !appBaseUrl.startsWith('https://')) {
  console.warn(
    `⚠️  NODE_ENV=production 但 APP_BASE_URL 不是 https（${appBaseUrl}）：` +
      '会话 cookie 不会带 Secure，CSP 也不会升级不安全请求。仅在本机直连时才应如此。'
  );
}

/**
 * 数据目录以工作目录为基准而非 __dirname——编译前后（app/ 与 dist/server/）
 * 相对层级不同，而 npm 脚本与 PM2 都从仓库根启动。
 */
const dataDir = raw.DATA_DIR ? resolve(raw.DATA_DIR) : resolve(process.cwd(), 'data');

export const config = {
  env: raw.NODE_ENV,
  isProduction,
  isTest,
  port,
  appBaseUrl,
  isHttps: appBaseUrl.startsWith('https://'),
  sessionSecret: resolveSessionSecret(),
  dataDir,
  forceSqlite: raw.FORCE_SQLITE === '1' || raw.FORCE_SQLITE?.toLowerCase() === 'true',

  superAdmin: {
    username: raw.ADMIN_USERNAME,
    password: raw.ADMIN_PASSWORD,
    isDefaultPassword: raw.ADMIN_PASSWORD === 'ChangeMe_12345'
  },

  mail: {
    apiKey: raw.RESEND_API_KEY ?? '',
    from: raw.EMAIL_FROM ?? '',
    get isConfigured(): boolean {
      return (raw.RESEND_API_KEY ?? '').length > 0 && (raw.EMAIL_FROM ?? '').length > 0;
    }
  },

  // 三个字段统一用空串表示「未设置」，交给 settingsService 与后台设置合并
  microsoft: {
    clientId: raw.MS_OAUTH_CLIENT_ID ?? '',
    clientSecret: raw.MS_OAUTH_CLIENT_SECRET ?? '',
    tenant: raw.MS_OAUTH_TENANT ?? ''
  }
} as const;

export type AppConfig = typeof config;
