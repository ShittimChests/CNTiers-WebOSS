import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../../../config/env.js';

/**
 * 把源文件路径解析成带 hash 的产物 URL。
 *
 * Vite 构建时生成 dist/public/.vite/manifest.json，这里据它拼 <script> 与 <link>。
 * 旧站用的是手写的 `styles.css?v=3.0`——两个文件里各写一次版本号、改一次要
 * 记得同步，而且静态目录压根没配缓存头，那个查询参数形同虚设。
 *
 * 生产环境读一次就缓存进内存；开发环境每次重读，这样 `vite build --watch`
 * 产出新 hash 后刷新页面即可见。
 */

const DIST_PUBLIC = resolve(process.cwd(), 'dist/public');
const MANIFEST_PATH = resolve(DIST_PUBLIC, '.vite/manifest.json');

interface ManifestEntry {
  file: string;
  css?: string[];
}

type Manifest = Record<string, ManifestEntry>;

let cached: Manifest | null = null;

function loadManifest(): Manifest {
  if (cached && config.isProduction) return cached;
  try {
    cached = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8')) as Manifest;
  } catch {
    // 尚未构建过：返回空表，assetUrl 会退回原路径，页面结构仍可查看
    if (!cached) {
      console.warn(`⚠️  未找到资产清单 ${MANIFEST_PATH}，请先执行 npm run build:assets。`);
      cached = {};
    }
  }
  return cached;
}

/** entry 用相对 app/ 的路径，如 'client/app.ts'、'styles/app.css'。 */
export function assetUrl(entry: string): string {
  const found = loadManifest()[entry];
  return `/${found?.file ?? entry}`;
}

/** 某个 JS 入口附带的样式文件（Vite 会把 import 的 CSS 拆出来）。 */
export function assetStyles(entry: string): string[] {
  return (loadManifest()[entry]?.css ?? []).map((file) => `/${file}`);
}

export const ASSET_DIR = DIST_PUBLIC;
