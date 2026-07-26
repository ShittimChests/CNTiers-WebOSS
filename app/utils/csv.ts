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

function escapeCell(value: unknown): string {
  const text = cellToText(value);
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
