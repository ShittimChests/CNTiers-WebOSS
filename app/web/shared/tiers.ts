/**
 * 段位 → 材质档位的映射。这是「材质段位」视觉语言的落点：
 * 石 → 铁 → 铜 → 金 → 钻石 → 绿宝石 → 下界合金，对应 Minecraft 自己的
 * 材质进阶顺序，这个受众一眼就能读出高低。
 *
 * 段位在后台是自由文本输入，因此匹配刻意宽容：忽略大小写、空格与
 * 可选的 "Subtier" 前缀。匹配不上的一律退回 stone，不报错也不留空白——
 * 旧站是靠 CSS 的 data-rank 精确匹配，管理员打错一个字母徽章就静默变灰。
 */
export const MATERIALS = [
  'stone',
  'iron',
  'copper',
  'gold',
  'diamond',
  'emerald',
  'netherite'
] as const;

export type Material = (typeof MATERIALS)[number];

const MATERIAL_BY_RANK: Record<string, Material> = {
  rookie: 'stone',
  novice: 'iron',
  cadet: 'copper',
  specialist: 'gold',
  ace: 'diamond',
  master: 'emerald',
  grandmaster: 'netherite'
};

export function materialForRank(rank: string): Material {
  const key = rank
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/^subtier/, '');
  return MATERIAL_BY_RANK[key] ?? 'stone';
}

/** 未定级的显示文本，集中在此以免各页各写一份。 */
export const UNRANKED_LABEL = 'Unranked';
