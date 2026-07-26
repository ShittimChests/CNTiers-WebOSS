/**
 * 生产环境必填项的守卫。
 *
 * 只能用子进程测：`app/config/env.ts` 是在**模块加载时**校验并 process.exit 的，
 * 在同一个 vitest 进程里 import 它会把整个测试进程带走。
 *
 * 值得为它花一次 spawn：这两条守卫在 CI 里永远不会被触发（CI 不设
 * NODE_ENV=production），所以除了这个文件没有任何东西守着它们。把 appBaseUrl
 * 改成惰性求值（仓库里 config.mail.isConfigured 就是那种写法）之类的重构会让
 * 启动期的 exit 静默消失，而门禁全绿。
 */
import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

interface LoadResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 在子进程里加载 env.ts，返回退出码与输出。 */
async function loadEnv(env: Record<string, string | undefined>): Promise<LoadResult> {
  // 只把需要的变量传进去：开发机上的 .env 与 shell 环境都会影响结果
  const child = {
    PATH: process.env['PATH'] ?? '',
    // dotenv/config 会读仓库根的 .env，指到一个不存在的文件上把它排除掉
    DOTENV_CONFIG_PATH: resolve(REPO_ROOT, '.env.does-not-exist'),
    ...env
  };

  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ['--import', 'tsx', '-e', "import('./app/config/env.ts').then(() => console.log('LOADED'))"],
      { cwd: REPO_ROOT, env: child, timeout: 60_000 }
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

const PRODUCTION = { NODE_ENV: 'production' };

describe('生产环境必填项', () => {
  it('缺 SESSION_SECRET 与 APP_BASE_URL 时拒绝启动，并一次列出全部缺项', async () => {
    // 逐项 exit 会让运维「补一个、重启、再看下一个」来回好几轮
    const result = await loadEnv(PRODUCTION);

    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain('LOADED');
    expect(result.stderr).toContain('SESSION_SECRET');
    expect(result.stderr).toContain('APP_BASE_URL');
  }, 90_000);

  it('SESSION_SECRET 太短也拒绝启动', async () => {
    /*
     * 它既是会话签名密钥，也是验证码 HMAC 的 HKDF 输入材料，短口令等于这两件事
     * 一起可爆破。校验只看长度不看熵，所以下限给得宽松（文档里的生成命令产出
     * 64 个十六进制字符）。
     */
    const result = await loadEnv({
      ...PRODUCTION,
      SESSION_SECRET: 'short',
      APP_BASE_URL: 'https://subtier.example.com'
    });

    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain('LOADED');
    expect(result.stderr).toContain('SESSION_SECRET');
    expect(result.stderr).toContain('32');
  }, 90_000);

  it('只缺 APP_BASE_URL 也拒绝启动', async () => {
    const result = await loadEnv({ ...PRODUCTION, SESSION_SECRET: 'x'.repeat(32) });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('APP_BASE_URL');
  }, 90_000);

  it('两项齐备即可启动；http:// 合法但必须给出告警', async () => {
    /*
     * 生产用 http 是合法的（本机直连、内网），但它会静默关掉 Secure cookie 与
     * upgrade-insecure-requests。旧站 src/server.js 有这条告警，重写时丢过一次。
     */
    const result = await loadEnv({
      ...PRODUCTION,
      SESSION_SECRET: 'x'.repeat(32),
      APP_BASE_URL: 'http://127.0.0.1:3000'
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('LOADED');
    expect(result.stderr).toContain('不是 https');
  }, 90_000);

  it('https 的完整配置安静通过', async () => {
    const result = await loadEnv({
      ...PRODUCTION,
      SESSION_SECRET: 'x'.repeat(32),
      APP_BASE_URL: 'https://subtier.example.com'
    });

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
  }, 90_000);

  it('开发环境不受这些强制约束', async () => {
    // 校验必须留在 isProduction 分支里；写进 zod schema 会让 dev/test 每次 import 都退出
    const result = await loadEnv({ NODE_ENV: 'development' });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('LOADED');
    expect(result.stderr).toContain('SESSION_SECRET 未设置');
  }, 90_000);
});
