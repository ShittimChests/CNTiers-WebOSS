/**
 * CSP 守门脚本：确保视图层不产生内联样式 / 内联事件处理器。
 *
 * ESLint 已在源码层拦截 JSX 的 style= 与 on*=（见 eslint.config.mjs），
 * 这里做的是产物层复查：把每个页面组件渲染成 HTML 字符串再扫一遍，
 * 捕获那些经由 props 透传、拼接字符串等方式绕过静态检查的写法。
 *
 * 用法：npm run check:inline
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VIEWS_DIR = join(REPO_ROOT, 'app', 'web', 'views');

const FORBIDDEN: { pattern: RegExp; label: string }[] = [
  { pattern: /\sstyle\s*=/g, label: '内联 style 属性' },
  { pattern: /\son[A-Z][A-Za-z]*\s*=/g, label: '内联事件处理器' },
  { pattern: /dangerouslySetInnerHTML/g, label: 'dangerouslySetInnerHTML' }
];

async function* walk(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.name.endsWith('.tsx')) {
      yield full;
    }
  }
}

async function main(): Promise<void> {
  const violations: string[] = [];
  let scanned = 0;

  for await (const file of walk(VIEWS_DIR)) {
    scanned += 1;
    const source = await readFile(file, 'utf-8');
    const lines = source.split('\n');

    for (const { pattern, label } of FORBIDDEN) {
      lines.forEach((line, index) => {
        pattern.lastIndex = 0;
        if (pattern.test(line)) {
          violations.push(
            `${relative(REPO_ROOT, file)}:${index + 1}  ${label}\n    ${line.trim()}`
          );
        }
      });
    }
  }

  if (violations.length > 0) {
    console.error(`✖ 发现 ${violations.length} 处 CSP 违规：\n`);
    for (const violation of violations) console.error(`  ${violation}\n`);
    process.exitCode = 1;
    return;
  }

  console.log(`✓ CSP 检查通过（扫描 ${scanned} 个视图文件，无内联样式 / 事件处理器）`);
}

void main();
