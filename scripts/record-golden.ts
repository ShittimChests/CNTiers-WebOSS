/**
 * 录制公开 API v1 的契约基线（golden）。
 *
 *   npx tsx scripts/record-golden.ts
 *
 * 做法：用固定 fixture 数据在隔离目录里启动**旧站**，逐一请求下面列出的
 * 请求变体，把「状态码 + 关键响应头 + 响应体」原样存进 tests/golden/api-v1.json。
 * 新实现的契约测试再拿同一份 fixture 灌入，逐字段比对。
 *
 * 为什么要录而不是手写期望值：错误文案来自 zod 的默认消息、404 文案里嵌了
 * 原始路径、tier 分桶的排序规则藏在实现细节里——手写一定会漏，而外部机器人
 * 正在消费这些响应。
 *
 * 录完请把 golden 提交进仓库，并且只在**故意**变更 API 时重录。
 */
import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_DIR = resolve(REPO_ROOT, 'tests/fixtures/legacy');
const GOLDEN_FILE = resolve(REPO_ROOT, 'tests/golden/api-v1.json');
const PORT = 3987;
const BASE = `http://127.0.0.1:${String(PORT)}`;

/** 只记录属于契约的响应头；Date、ETag 之类每次都变的不能进 golden。 */
const RECORDED_HEADERS = [
  'content-type',
  'cache-control',
  'access-control-allow-origin',
  'access-control-allow-methods',
  'access-control-allow-headers',
  'retry-after',
  'access-control-max-age'
] as const;

interface RequestSpec {
  name: string;
  method: 'GET' | 'OPTIONS';
  path: string;
}

/**
 * 请求变体清单。覆盖：正常读取、分页边界、越界参数、大小写不敏感查找、
 * 两种 404、CORS 预检、以及路由兜底。
 */
const SPECS: RequestSpec[] = [
  { name: 'gamemodes', method: 'GET', path: '/api/v1/gamemodes' },

  { name: 'rankings.default', method: 'GET', path: '/api/v1/rankings' },
  { name: 'rankings.paged', method: 'GET', path: '/api/v1/rankings?limit=2&offset=1' },
  { name: 'rankings.offset.beyond', method: 'GET', path: '/api/v1/rankings?offset=99' },
  { name: 'rankings.limit.zero', method: 'GET', path: '/api/v1/rankings?limit=0' },
  { name: 'rankings.limit.tooLarge', method: 'GET', path: '/api/v1/rankings?limit=201' },
  { name: 'rankings.limit.notNumber', method: 'GET', path: '/api/v1/rankings?limit=abc' },
  { name: 'rankings.offset.negative', method: 'GET', path: '/api/v1/rankings?offset=-1' },

  { name: 'gamemode.sword', method: 'GET', path: '/api/v1/rankings/Sword' },
  { name: 'gamemode.caseInsensitive', method: 'GET', path: '/api/v1/rankings/sWoRd' },
  { name: 'gamemode.count', method: 'GET', path: '/api/v1/rankings/Sword?count=1' },
  { name: 'gamemode.countOffset', method: 'GET', path: '/api/v1/rankings/Sword?count=1&offset=1' },
  { name: 'gamemode.spaceInName', method: 'GET', path: '/api/v1/rankings/Trident%20Box' },
  { name: 'gamemode.emptyBuckets', method: 'GET', path: '/api/v1/rankings/Crystal' },
  { name: 'gamemode.notFound', method: 'GET', path: '/api/v1/rankings/NoSuchMode' },
  { name: 'gamemode.count.tooLarge', method: 'GET', path: '/api/v1/rankings/Sword?count=51' },

  { name: 'player.found', method: 'GET', path: '/api/v1/players/Alice' },
  { name: 'player.caseInsensitive', method: 'GET', path: '/api/v1/players/aLiCe' },
  { name: 'player.unparseableTier', method: 'GET', path: '/api/v1/players/Dave' },
  { name: 'player.notFound', method: 'GET', path: '/api/v1/players/NoSuchPlayer' },

  { name: 'cors.preflight', method: 'OPTIONS', path: '/api/v1/gamemodes' },
  { name: 'route.notFound', method: 'GET', path: '/api/v1/nope' }
];

interface GoldenRecord {
  request: { method: string; path: string };
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

async function prepareDataDir(): Promise<string> {
  const dir = await mkdtemp(resolve(tmpdir(), 'subtier-golden-'));
  for (const file of ['users.json', 'leaderboard.json', 'settings.json']) {
    await copyFile(resolve(FIXTURE_DIR, file), resolve(dir, file));
  }
  return dir;
}

async function waitForServer(): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${BASE}/api/v1/gamemodes`);
      if (response.ok) return;
    } catch {
      // 还没起来，继续等
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('旧站在 15 秒内没有就绪');
}

async function record(spec: RequestSpec): Promise<GoldenRecord> {
  const response = await fetch(`${BASE}${spec.path}`, { method: spec.method });

  const headers: Record<string, string> = {};
  for (const name of RECORDED_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null) headers[name] = value;
  }

  const text = await response.text();
  let body: unknown = text;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      // 非 JSON 就按原文记录，便于发现契约破坏
    }
  } else {
    body = null;
  }

  return {
    request: { method: spec.method, path: spec.path },
    status: response.status,
    headers,
    body
  };
}

async function main(): Promise<void> {
  const dataDir = await prepareDataDir();
  console.log(`fixture 数据目录：${dataDir}`);

  const server = spawn(process.execPath, [resolve(REPO_ROOT, 'src/server.js')], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: String(PORT),
      DATA_DIR: dataDir,
      SESSION_SECRET: 'golden-recording-secret',
      // 关掉注册与 OAuth，避免录制过程受外部服务影响
      RESEND_API_KEY: '',
      MS_OAUTH_CLIENT_SECRET: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let serverLog = '';
  server.stdout.on('data', (chunk: Buffer) => (serverLog += chunk.toString()));
  server.stderr.on('data', (chunk: Buffer) => (serverLog += chunk.toString()));

  try {
    await waitForServer();
    console.log('旧站已就绪，开始录制…\n');

    const records: Record<string, GoldenRecord> = {};
    for (const spec of SPECS) {
      const result = await record(spec);
      records[spec.name] = result;
      console.log(`  ${String(result.status)}  ${spec.method} ${spec.path}`);
    }

    await mkdir(dirname(GOLDEN_FILE), { recursive: true });
    await writeFile(GOLDEN_FILE, `${JSON.stringify(records, null, 2)}\n`, 'utf-8');
    console.log(`\n✓ 已写入 ${String(Object.keys(records).length)} 条基线 → ${GOLDEN_FILE}`);
  } catch (error) {
    console.error('录制失败：', error);
    console.error('--- 旧站日志 ---\n', serverLog);
    process.exitCode = 1;
  } finally {
    server.kill('SIGTERM');
    await rm(dataDir, { recursive: true, force: true });
  }
}

await main();
