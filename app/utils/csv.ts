/**
 * 最小 CSV 序列化。不引依赖——导出只有一处用途，且需要精确控制
 * Excel 兼容细节（BOM + CRLF）。
 */

/**
 * Excel 只有看到 UTF-8 BOM 才会把中文列按 UTF-8 解码，不能省。
 * 用转义写法而非字面字符——BOM 在编辑器里不可见，容易被误删。
 */
export const UTF8_BOM = '\ufeff';

function cellToText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return value.toString();
  }
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value) ?? '';
}

/**
 * Excel / Sheets 会把以 `=` `+` `-` `@` 开头的单元格当公式执行，于是一个叫
 * `=HYPERLINK("http://…")` 的玩家名会在别人打开导出时触发。玩家名与段位没有
 * 字符集限制（见 validation.ts 的 entrySchema），所以这条不是理论风险。
 *
 * 只处理**字符串**单元格：数字走 cellToText 的 toString，负分的 `-5` 是合法数据，
 * 给它加前缀会把一列数字变成文本。制表符与回车也要算进去——它们同样能开一个
 * 新的解析上下文。
 */
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

function escapeCell(value: unknown): string {
  const raw = cellToText(value);
  const text = typeof value === 'string' && FORMULA_PREFIX.test(raw) ? `'${raw}` : raw;
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function toCsv(headers: string[], rows: readonly unknown[][]): string {
  const lines = [headers.map(escapeCell).join(',')];
  for (const row of rows) {
    lines.push(row.map(escapeCell).join(','));
  }
  return UTF8_BOM + lines.join('\r\n') + '\r\n';
}
