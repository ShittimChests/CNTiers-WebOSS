import { z } from 'zod';
import { API_LIMITS, FIELD_LIMITS } from '../config/constants.js';
import { AppError } from '../errors/AppError.js';

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

/**
 * 按名字指认一个**已存在**的项目（删除、以及改名的来源名）。
 *
 * 刻意既不带字符集正则、也不用新建时的长度上限：库里的项目名来自旧数据，
 * 未必符合今天新建的规则。两条都是真实来源——旧站的 Excel 导入直接把表头
 * `String(header).trim()` 当项目名，既不校验字符集也不校验长度，而 SQLite
 * 根本不强制 varchar(48)，所以库里确实可能存在 60 字符或含中文的项目名。
 * 用新建规则去卡，这类历史项目在后台里就既删不掉也改不了。
 *
 * 上限仍然要有（防止无界输入），但取一个只与「能不能进数据库」有关的宽值。
 */
const CATEGORY_LOOKUP_MAX = 255;

const categoryLookupName = trimmed.min(1).max(CATEGORY_LOOKUP_MAX);

export const categoryLookupSchema = z.object({ name: categoryLookupName });

export const categoryRenameSchema = z.object({
  // 来源名走 lookup 规则（库里的既有数据），目标名才走新建规则
  from: categoryLookupName,
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
 *
 * 既是反序列化也是校验：字段名是动态的，zod 的对象 schema 表达不了「任意
 * `category__*` 键」，所以长度约束只能在这里落地。
 *
 * **tier 的长度必须在服务端卡住。** 列是 `varchar(32)`，而三种方言对超长值的
 * 反应完全不同：SQLite 根本不强制，照单全收；PostgreSQL 直接报错；MySQL 严格
 * 模式下报错、非严格模式下静默截断。视图上的 `maxlength={32}` 只是个客户端属性，
 * curl 一下就没了。放任的后果不止是一次 500——超长值会先安静地躺在 SQLite 里，
 * 等到日后走面板 migrate 到 PostgreSQL 时才在 `#copyAll` 里炸，那时既看不出是
 * 哪一行也看不出是哪一列。项目名同理（它只用于查找，但没有上界就是无界输入）。
 */
export function parseTierPayload(body: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(body)) {
    if (!key.startsWith('category__')) continue;
    const name = key.slice('category__'.length);
    if (name.length === 0 || typeof raw !== 'string') continue;
    if (name.length > CATEGORY_LOOKUP_MAX) {
      throw new AppError('invalid_input', {
        meta: { field: key, reason: 'category_name_too_long' }
      });
    }
    const value = raw.trim();
    // 空值表示未定级——不建行，而不是存空字符串
    if (value.length === 0) continue;
    if (value.length > FIELD_LIMITS.tier.max) {
      throw new AppError('invalid_input', {
        meta: {
          field: key,
          reason: 'tier_too_long',
          limit: FIELD_LIMITS.tier.max,
          actual: value.length
        }
      });
    }
    out[name] = value;
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
