/**
 * 设计 token 的对比度核查（WCAG 2.1）。
 *
 *   npm run check:contrast
 *
 * 深色主题最容易出问题的地方是「看起来够、其实不够」的次要文字与强调色。
 * 把配对关系写成清单并自动计算，改 token 时就不必靠肉眼复查。
 *
 * 阈值：正文 4.5:1；大号文字与 UI 边界 3:1（WCAG 1.4.3 / 1.4.11）。
 */
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOKENS_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../app/styles/tokens.css');

type Rgb = [number, number, number];

function parseHex(hex: string): Rgb {
  const value = hex.replace('#', '');
  const full =
    value.length === 3
      ? value
          .split('')
          .map((c) => c + c)
          .join('')
      : value;
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16)
  ];
}

/** sRGB → 相对亮度（WCAG 定义）。 */
function luminance([r, g, b]: Rgb): number {
  const channel = (raw: number): number => {
    const c = raw / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(fg: Rgb, bg: Rgb): number {
  const a = luminance(fg);
  const b = luminance(bg);
  const [light, dark] = a > b ? [a, b] : [b, a];
  return (light + 0.05) / (dark + 0.05);
}

/** 模拟 CSS 的 color-mix(in srgb, fg P%, transparent) 叠在 base 上的结果。 */
function mixOver(fg: Rgb, base: Rgb, percent: number): Rgb {
  const ratio = percent / 100;
  return [0, 1, 2].map((i) => Math.round(fg[i]! * ratio + base[i]! * (1 - ratio))) as Rgb;
}

async function readTokens(): Promise<Map<string, Rgb>> {
  const css = await readFile(TOKENS_PATH, 'utf-8');
  const tokens = new Map<string, Rgb>();
  const pattern = /--([a-z0-9-]+):\s*(#[0-9a-fA-F]{3,6})\s*;/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(css)) !== null) {
    tokens.set(match[1]!, parseHex(match[2]!));
  }
  return tokens;
}

interface Check {
  label: string;
  fg: string;
  bg: string;
  min: number;
  /** 徽章类元素的底色是前景色的低透明度混色叠在卡片上。 */
  mix?: number;
}

const CHECKS: Check[] = [
  // 正文
  { label: '正文 / 页面底', fg: 'text-1', bg: 'bg-0', min: 4.5 },
  { label: '正文 / 卡片', fg: 'text-1', bg: 'bg-1', min: 4.5 },
  { label: '正文 / 内嵌块', fg: 'text-1', bg: 'bg-2', min: 4.5 },
  { label: '次要文字 / 页面底', fg: 'text-2', bg: 'bg-0', min: 4.5 },
  { label: '次要文字 / 卡片', fg: 'text-2', bg: 'bg-1', min: 4.5 },
  { label: '次要文字 / 内嵌块', fg: 'text-2', bg: 'bg-2', min: 4.5 },
  // text-3 只用于小标签与占位，按 UI 组件阈值
  { label: '三级文字 / 卡片（仅次要信息）', fg: 'text-3', bg: 'bg-1', min: 3 },

  // 交互
  { label: '链接 / 卡片', fg: 'link', bg: 'bg-1', min: 4.5 },
  { label: '链接 hover / 卡片', fg: 'link-hover', bg: 'bg-1', min: 4.5 },
  { label: '主按钮文字 / 金底', fg: 'gold-ink', bg: 'gold', min: 4.5 },
  { label: '金色强调 / 卡片', fg: 'gold', bg: 'bg-1', min: 3 },
  { label: '焦点环 / 页面底', fg: 'gold-hover', bg: 'bg-0', min: 3 },

  // 状态
  { label: '成功色 / 卡片', fg: 'ok', bg: 'bg-1', min: 3 },
  { label: '危险色 / 卡片', fg: 'danger', bg: 'bg-1', min: 3 },
  { label: '警告色 / 卡片', fg: 'warn', bg: 'bg-1', min: 3 },

  // 段位徽章：文字色叠在自身 14% 混色底上
  { label: '徽章 石 / 混色底', fg: 'tier-stone', bg: 'bg-1', min: 4.5, mix: 14 },
  { label: '徽章 铁 / 混色底', fg: 'tier-iron', bg: 'bg-1', min: 4.5, mix: 14 },
  { label: '徽章 铜 / 混色底', fg: 'tier-copper', bg: 'bg-1', min: 4.5, mix: 14 },
  { label: '徽章 金 / 混色底', fg: 'tier-gold', bg: 'bg-1', min: 4.5, mix: 14 },
  { label: '徽章 钻石 / 混色底', fg: 'tier-diamond', bg: 'bg-1', min: 4.5, mix: 14 },
  { label: '徽章 绿宝石 / 混色底', fg: 'tier-emerald', bg: 'bg-1', min: 4.5, mix: 14 },
  { label: '徽章 下界合金', fg: 'tier-netherite-ink', bg: 'tier-netherite-bg', min: 4.5 }
];

async function main(): Promise<void> {
  const tokens = await readTokens();
  const failures: string[] = [];

  console.log('对比度核查（WCAG 2.1）\n');

  for (const check of CHECKS) {
    const fg = tokens.get(check.fg);
    const baseBg = tokens.get(check.bg);
    if (!fg || !baseBg) {
      failures.push(`${check.label}：找不到 token（${check.fg} / ${check.bg}）`);
      continue;
    }

    const bg = check.mix === undefined ? baseBg : mixOver(fg, baseBg, check.mix);
    const ratio = contrast(fg, bg);
    const pass = ratio >= check.min;
    const mark = pass ? '✓' : '✗';
    console.log(
      `  ${mark} ${check.label.padEnd(28, '·')} ${ratio.toFixed(2)}:1 （需 ≥ ${check.min.toFixed(1)}）`
    );
    if (!pass) {
      failures.push(`${check.label}：${ratio.toFixed(2)}:1，未达 ${check.min.toFixed(1)}:1`);
    }
  }

  if (failures.length > 0) {
    console.error(`\n✖ ${String(failures.length)} 项未达标：`);
    for (const failure of failures) console.error(`  ${failure}`);
    process.exitCode = 1;
    return;
  }

  console.log(`\n✓ ${String(CHECKS.length)} 项全部达标。`);
}

await main();
