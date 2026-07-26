import { ERROR_CODES, isErrorCode, type ErrorCode } from '../../errors/codes.js';

/**
 * 面向用户的文案字典（成功与提示类）。错误类文案在 errors/codes.ts。
 *
 * 旧站有四套并存的文案机制：模板内的 errMap 字面量、路由里的 successMap、
 * 直接当参数传的中文串、以及 session flash。同一个 code 在三个模板里有三种
 * 说法。这里把「键 → 文案」收敛成唯一来源，模板只负责查表。
 *
 * 写法约定：主动语态、句子大小写、说清发生了什么而不是道歉。
 * 动作名要贯穿整个流程——按钮叫「保存修改」，成功提示就说「修改已保存」。
 */
export const MESSAGES = {
  // 认证
  'auth.verified': '邮箱验证成功，现在可以用账号或邮箱登录',
  'auth.loggedOut': '已退出登录',
  'auth.passwordReset': '密码已重置，请用新密码登录',
  'auth.codeSent': '验证码已发送，请查收邮件',
  'auth.registered': '注册成功，验证码已发送到你的邮箱',

  // 账户
  'account.passwordChanged': '密码已更新',
  'account.passwordCreated': '本地密码已设置',
  'account.microsoftLinked': '已绑定 Microsoft 账户',
  'account.microsoftUnlinked': '已解绑 Microsoft 账户',

  // 后台：榜单条目
  'admin.entry.created': '条目已添加',
  'admin.entry.updated': '条目已更新',
  'admin.entry.deleted': '条目已删除',

  // 后台：细分项目
  'admin.category.created': '细分项目已添加',
  'admin.category.renamed': '细分项目已改名',
  'admin.category.deleted': '细分项目已删除',

  // 后台：设置与用户
  'admin.settings.saved': '设置已保存',
  'admin.user.promoted': '已提升为管理员',
  'admin.user.demoted': '已降级为普通用户',
  'admin.user.deleted': '用户已删除',

  // 后台：数据库
  'admin.db.tested': '连接测试成功',
  'admin.db.switched': '数据库已切换，请重新登录'
} as const;

export type MessageKey = keyof typeof MESSAGES;

/** flash 与内联提示都用同一套键空间：错误码 或 文案键。 */
export type MessageId = ErrorCode | MessageKey;

export type MessageParams = Record<string, string | number>;

function isMessageKey(value: string): value is MessageKey {
  return Object.hasOwn(MESSAGES, value);
}

/**
 * 解析文案。`{name}` 形式的占位符由 params 填充——
 * 用于「还有 3 次尝试机会」这类需要动态数字的场景。
 */
export function resolveMessage(id: MessageId, params?: MessageParams): string {
  const template = isErrorCode(id)
    ? ERROR_CODES[id].message
    : isMessageKey(id)
      ? MESSAGES[id]
      : // 未知键不该出现，但也不该让页面崩掉
        '操作已完成';

  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = params[key];
    return value === undefined ? match : String(value);
  });
}

export type FlashKind = 'success' | 'error' | 'info';

export interface Flash {
  kind: FlashKind;
  id: MessageId;
  params?: MessageParams;
}
