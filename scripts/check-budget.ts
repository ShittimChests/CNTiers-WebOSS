/**
 * 前端产物体积预算。
 *
 *   npm run check:budget   （需先 npm run build:assets）
 *
 * 站点要在低端移动设备上流畅，而体积是最容易悄悄膨胀的东西——
 * 一次「顺手引个库」就能把首屏 JS 翻几倍。把预算写成检查，
 * 越界时 CI 直接失败。
 */
import { gzipSync } from 'node:zlib';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ASSETS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../dist/public/assets');

/** 单位：gzip 后的字节数。 */
const BUDGETS: { pattern: RegExp; label: string; maxGzip: number }[] = [
  { pattern: /^app\..*\.js$/, label: '全局脚本', maxGzip: 8 * 1024 },
  { pattern: /^board\..*\.js$/, label: '榜单页脚本', maxGzip: 6 * 1024 },
  { pattern: /^admin\..*\.js$/, label: '后台页脚本', maxGzip: 6 * 1024 },
  { pattern: /^styles\..*\.css$/, label: '样式表', maxGzip: 35 * 1024 }
];

async function main(): Promise<void> {
  let files: string[];
  try {
    files = await readdir(ASSETS_DIR);
  } catch {
    console.error(`✖ 找不到产物目录 ${ASSETS_DIR}，请先执行 npm run build:assets。`);
    process.exitCode = 1;
    return;
  }

  const failures: string[] = [];
  console.log('前端产物预算（gzip 后）\n');

  for (const budget of BUDGETS) {
    const match = files.find((file) => budget.pattern.test(file));
    if (!match) {
      failures.push(`${budget.label}：找不到匹配 ${String(budget.pattern)} 的产物`);
      continue;
    }

    const raw = await readFile(join(ASSETS_DIR, match));
    const gzipped = gzipSync(raw).byteLength;
    const pass = gzipped <= budget.maxGzip;
    const percent = Math.round((gzipped / budget.maxGzip) * 100);

    console.log(
      `  ${pass ? '✓' : '✗'} ${budget.label.padEnd(12, '·')} ` +
        `${(gzipped / 1024).toFixed(2)} KB / ${String(budget.maxGzip / 1024)} KB  (${String(percent)}%)`
    );

    if (!pass) {
      failures.push(
        `${budget.label}：${(gzipped / 1024).toFixed(2)} KB 超出预算 ${String(budget.maxGzip / 1024)} KB`
      );
    }
  }

  if (failures.length > 0) {
    console.error('\n✖ 超出预算：');
    for (const failure of failures) console.error(`  ${failure}`);
    process.exitCode = 1;
    return;
  }

  console.log('\n✓ 全部在预算内。');
}

await main();
