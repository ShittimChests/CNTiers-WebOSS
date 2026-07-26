import { z } from 'zod';
import { API_LIMITS, FIELD_LIMITS } from '../config/constants.js';

/**
 * 输入校验 schema。
 *
 * 公开 API 的这几个 schema 是**契约的一部分**：错误响应里的 message 直接取自
 * zod 的 issues[0].message，因此约束的种类与边界值都不能改
 * （例如 min(1) 会产出 "Too small: expected number to be >=1"）。
 * 改动前先跑 tests/contract/apiV1.test.ts。
 */

export const apiListPaginationSchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(API_LIMITS.rankingsLimit.min)
    .max(API_LIMITS.rankingsLimit.max)
    .default(API_LIMITS.rankingsLimit.default),
  offset: z.coerce.number().int().min(0).default(0)
});

export const apiTierPaginationSchema = z.object({
  count: z.coerce
    .number()
    .int()
    .min(API_LIMITS.gamemodeCount.min)
    .max(API_LIMITS.gamemodeCount.max)
    .default(API_LIMITS.gamemodeCount.default),
  offset: z.coerce.number().int().min(0).default(0)
});

export const apiGamemodeNameSchema = z.string().trim().min(1).max(64);
export const apiPlayerNameSchema = z.string().trim().min(1).max(64);

// ---------- 表单 ----------

const trimmed = z.string().trim();

/** 空字符串归一为 null。旧站的 testServer 在两种表示间混用。 */
const nullableText = (max: number) =>
  trimmed
    .max(max)
    .transform((value) => (value.length === 0 ? null : value))
    .nullable();

export const loginSchema = z.object({
  identifier: trimmed.min(1).max(254),
  password: z.string().min(1).max(FIELD_LIMITS.password.max)
});

export const registerSchema = z
  .object({
    username: trimmed
      .min(FIELD_LIMITS.username.min)
      .max(FIELD_LIMITS.username.max)
      .regex(/^[A-Za-z0-9_-]+$/, '用户名只能包含字母、数字、下划线与短横线'),
    email: trimmed.min(3).max(254).email('请输入有效的邮箱地址'),
    password: z.string().min(FIELD_LIMITS.password.min).max(FIELD_LIMITS.password.max),
    passwordConfirm: z.string()
  })
  .refine((data) => data.password === data.passwordConfirm, {
    message: '两次输入的密码不一致',
    path: ['passwordConfirm']
  });

export const emailOnlySchema = z.object({
  email: trimmed.min(3).max(254).email('请输入有效的邮箱地址')
});

export const verifyCodeSchema = z.object({
  email: trimmed.min(3).max(254),
  code: trimmed.regex(/^\d{6}$/, '验证码是 6 位数字')
});

export const resetSchema = z
  .object({
    email: trimmed.min(3).max(254),
    code: trimmed.regex(/^\d{6}$/, '验证码是 6 位数字'),
    password: z.string().min(FIELD_LIMITS.password.min).max(FIELD_LIMITS.password.max),
    passwordConfirm: z.string()
  })
  .refine((data) => data.password === data.passwordConfirm, {
    message: '两次输入的密码不一致',
    path: ['passwordConfirm']
  });

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().max(FIELD_LIMITS.password.max).optional(),
    password: z.string().min(FIELD_LIMITS.password.min).max(FIELD_LIMITS.password.max),
    passwordConfirm: z.string()
  })
  .refine((data) => data.password === data.passwordConfirm, {
    message: '两次输入的密码不一致',
    path: ['passwordConfirm']
  });

export const idSchema = z.object({
  id: trimmed.min(1).max(FIELD_LIMITS.id.max)
});

export const entrySchema = z.object({
  player: trimmed.min(FIELD_LIMITS.player.min).max(FIELD_LIMITS.player.max),
  rank: trimmed.min(FIELD_LIMITS.rank.min).max(FIELD_LIMITS.rank.max),
  points: z.coerce.number().int().min(FIELD_LIMITS.points.min).max(FIELD_LIMITS.points.max),
  testServer: nullableText(FIELD_LIMITS.testServer.max).optional().default(null)
});

/** 快速编辑：只更新实际出现在请求体里的字段。 */
export const quickEditSchema = z.object({
  rank: trimmed.min(FIELD_LIMITS.rank.min).max(FIELD_LIMITS.rank.max).optional(),
  points: z.coerce
    .number()
    .int()
    .min(FIELD_LIMITS.points.min)
    .max(FIELD_LIMITS.points.max)
    .optional(),
  testServer: nullableText(FIELD_LIMITS.testServer.max).optional()
});

export const categoryNameSchema = z.object({
  name: trimmed
    .min(FIELD_LIMITS.categoryName.min)
    .max(FIELD_LIMITS.categoryName.max)
    .regex(/^[A-Za-z0-9 _-]+$/, '项目名只能包含字母、数字、空格、下划线与短横线')
});

export const categoryRenameSchema = z.object({
  from: trimmed.min(1).max(FIELD_LIMITS.categoryName.max),
  to: trimmed
    .min(FIELD_LIMITS.categoryName.min)
    .max(FIELD_LIMITS.categoryName.max)
    .regex(/^[A-Za-z0-9 _-]+$/, '项目名只能包含字母、数字、空格、下划线与短横线')
});

/** 复选框未勾选时根本不出现在请求体里，因此缺失即 false。 */
const checkbox = z
  .union([z.literal('on'), z.literal('true'), z.literal('1')])
  .optional()
  .transform((value) => value !== undefined);

export const settingsSchema = z.object({
  registrationEnabled: checkbox,
  oauthEnabled: checkbox,
  oauthClientId: trimmed.max(128).optional().default(''),
  oauthTenant: trimmed.max(64).optional().default('common')
});

/**
 * 从 `category__<名字>` 形式的字段里收集定级。
 * 这是表单向数据结构的反序列化，不是校验，因此单独成函数。
 */
export function parseTierPayload(body: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(body)) {
    if (!key.startsWith('category__')) continue;
    const name = key.slice('category__'.length);
    if (name.length === 0 || typeof raw !== 'string') continue;
    const value = raw.trim();
    // 空值表示未定级——不建行，而不是存空字符串
    if (value.length > 0) out[name] = value;
  }
  return out;
}

/** 榜单排序参数，非法值退回默认而不是报错（URL 是用户可编辑的）。 */
export const boardQuerySchema = z.object({
  sort: z.enum(['position', 'player', 'points', 'rank']).catch('position'),
  dir: z.enum(['asc', 'desc']).catch('asc'),
  q: trimmed.max(64).catch('')
});

export const pageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).catch(1)
});
