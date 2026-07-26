/**
 * Tier 字符串解析：形如 HT1 / LT5（High/Low + 1..5）。
 *
 * 数据层不对 tier 加约束——历史数据里存在无法解析的值，公开 API 的既有语义是
 * 「warn 并跳过」而非报错。这里只负责解析，取舍留给调用方。
 */

const TIER_RE = /^(HT|LT)([1-5])$/i;

export interface ParsedTier {
  /** 规范化大写形式，如 "HT3"。 */
  canonical: string;
  half: 'HT' | 'LT';
  major: number;
}

export function parseTier(raw: unknown): ParsedTier | null {
  if (typeof raw !== 'string') return null;
  const match = TIER_RE.exec(raw.trim());
  if (!match) return null;
  const half = match[1]!.toUpperCase() as 'HT' | 'LT';
  const major = Number(match[2]);
  return { canonical: `${half}${String(major)}`, half, major };
}

/**
 * 分桶内排序键：HT 先于 LT，再按积分降序，最后按名字升序。
 * 返回负数表示 a 在前，供 Array#sort 直接使用。
 */
export function compareWithinTier(
  a: { half: 'HT' | 'LT'; points: number; name: string },
  b: { half: 'HT' | 'LT'; points: number; name: string }
): number {
  if (a.half !== b.half) return a.half === 'HT' ? -1 : 1;
  if (a.points !== b.points) return b.points - a.points;
  return a.name.localeCompare(b.name);
}
