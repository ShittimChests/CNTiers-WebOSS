/**
 * CSV 序列化。重点是公式注入那条：导出的用途就是拿去 Excel 打开。
 */
import { describe, expect, it } from 'vitest';
import { toCsv, UTF8_BOM } from '../../app/utils/csv.js';

/** 去掉 BOM 与末尾换行，按行拆开，便于逐格断言。 */
function lines(csv: string): string[] {
  return csv.slice(UTF8_BOM.length).replace(/\r\n$/, '').split('\r\n');
}

describe('toCsv', () => {
  it('带 BOM 与 CRLF（Excel 才会按 UTF-8 解码中文列）', () => {
    const csv = toCsv(['名字'], [['甲']]);
    expect(csv.startsWith(UTF8_BOM)).toBe(true);
    expect(csv.endsWith('\r\n')).toBe(true);
  });

  it('含引号、逗号或换行的单元格被引起来并转义引号', () => {
    expect(lines(toCsv(['a'], [['x,y']]))[1]).toBe('"x,y"');
    expect(lines(toCsv(['a'], [['他说"好"']]))[1]).toBe('"他说""好"""');
    expect(lines(toCsv(['a'], [['第一行\n第二行']]))[1]).toBe('"第一行\n第二行"');
  });

  it.each([['=HYPERLINK("http://evil","点我")'], ['+1+1'], ['@SUM(A1)'], ['-2+3']])(
    '以公式字符开头的**字符串**被前缀单引号中和（%s）',
    (payload) => {
      /*
       * 玩家名与段位没有字符集限制（见 validation.ts 的 entrySchema），一个
       * Admin 就能把名字设成公式，等另一个管理员用 Excel 打开导出时触发。
       */
      const cell = lines(toCsv(['player'], [[payload]]))[1] ?? '';
      // 中和只加前缀，不改内容；引号转义是后一步，比较前先还原
      const unquoted = cell.startsWith('"') ? cell.slice(1, -1).replace(/""/g, '"') : cell;
      expect(unquoted).toBe(`'${payload}`);
    }
  );

  it('制表符与回车开头同样中和（它们也能开一个新的解析上下文）', () => {
    expect(lines(toCsv(['a'], [['\t=1+1']]))[1]).toBe("'\t=1+1");
  });

  it('数字不受影响——负分是合法数据，加前缀会把一整列变成文本', () => {
    expect(lines(toCsv(['points'], [[-5]]))[1]).toBe('-5');
    expect(lines(toCsv(['points'], [[0]]))[1]).toBe('0');
  });

  it('null 与 undefined 渲染成空格', () => {
    expect(lines(toCsv(['a', 'b'], [[null, undefined]]))[1]).toBe(',');
  });
});
