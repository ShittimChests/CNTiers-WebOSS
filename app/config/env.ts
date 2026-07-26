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
  MS_OAUTH_TENANT: trimmed.default('common'),

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

function resolveSessionSecret(): string {
  if (raw.SESSION_SECRET && raw.SESSION_SECRET.length > 0) return raw.SESSION_SECRET;
  if (isProduction) {
    console.error(
      '✖ 生产环境必须设置 SESSION_SECRET。\n' +
        '  它同时用于会话签名与验证码 HMAC 派生，缺失会导致重启后会话与验证码全部失效。\n' +
        "  生成方式：node -e \"console.log(require('node:crypto').randomBytes(32).toString('hex'))\""
    );
    process.exit(1);
  }
  const temporary = randomBytes(32).toString('hex');
  if (!isTest) {
    console.warn('⚠️  SESSION_SECRET 未设置，本次运行使用临时密钥，重启后会话会失效。');
  }
  return temporary;
}

const port = raw.PORT;
const appBaseUrl = (raw.APP_BASE_URL ?? `http://localhost:${port}`).replace(/\/+$/, '');

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

  microsoft: {
    clientId: raw.MS_OAUTH_CLIENT_ID ?? '',
    clientSecret: raw.MS_OAUTH_CLIENT_SECRET ?? '',
    tenant: raw.MS_OAUTH_TENANT
  }
} as const;

export type AppConfig = typeof config;
