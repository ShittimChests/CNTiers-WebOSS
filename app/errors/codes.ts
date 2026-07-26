/**
 * 错误码集中表 —— 全站唯一事实来源。
 *
 * 旧实现有 5 套并存的错误处理方式（裸中文串、?error= 查询码、模板内映射表、
 * flash、静默降级），同一个 code 在三个模板里有三种文案。这里把「码 → HTTP 状态
 * → 用户可见文案」绑定在一处，路由只抛码，呈现层只查表。
 *
 * status 用于 API 与 HTTP 语义；message 是面向终端用户的中文，不含内部细节。
 */

export const ERROR_CODES = {
  // --- 通用 ---
  invalid_input: { status: 400, message: '提交内容不合法，请检查后重试' },
  not_found: { status: 404, message: '找不到请求的资源' },
  forbidden: { status: 403, message: '你没有权限执行此操作' },
  unauthorized: { status: 401, message: '请先登录' },
  internal_error: { status: 500, message: '服务器出错了，请稍后再试' },
  rate_limited: { status: 429, message: '操作过于频繁，请稍后再试' },
  csrf_invalid: { status: 403, message: '安全校验失败，请刷新页面后重试' },
  maintenance: { status: 503, message: '系统正在维护中，请稍后再试' },

  // --- 认证 ---
  invalid_credentials: { status: 401, message: '账号或密码错误' },
  email_not_verified: { status: 403, message: '邮箱尚未验证，请先完成验证' },
  registration_disabled: { status: 404, message: '当前未开放注册' },
  username_taken: { status: 409, message: '该用户名已被占用' },
  email_taken: { status: 409, message: '该邮箱已被注册' },
  password_mismatch: { status: 400, message: '两次输入的密码不一致' },
  current_password_wrong: { status: 400, message: '当前密码不正确' },
  needs_password: { status: 400, message: '请先设置本地密码，否则解绑后将无法登录' },

  /*
   * --- 验证码 ---
   *
   * 这三条**必须是同一句话**。它们区分的是「这个邮箱没有账号 / 有账号但码过期
   * / 有账号且码错了」，一旦文案不同，攻击者拿一个乱填的验证码打一次
   * POST /verify 或 POST /reset 就能读出邮箱是否注册过——确定性、无需计时、
   * 比 /forgot 上那条被修掉的信道还好用。
   *
   * 代价是用户看不到「还有 N 次尝试机会」。这是有意的取舍：那个计数只对
   * 真实存在的账号才有意义，展示它就等于回答了账号是否存在。剩余次数仍在
   * AppError 的 meta 里，需要时可用于日志。
   */
  code_expired: { status: 400, message: '验证码不正确或已过期，请重新获取' },
  code_invalid: { status: 400, message: '验证码不正确或已过期，请重新获取' },
  code_locked: { status: 400, message: '验证码不正确或已过期，请重新获取' },
  cooldown_active: { status: 429, message: '发送过于频繁，请稍后再试' },
  mail_not_configured: { status: 503, message: '邮件服务尚未配置，暂时无法发送验证码' },
  mail_send_failed: { status: 502, message: '验证码发送失败，请稍后重试' },

  // --- OAuth ---
  oauth_disabled: { status: 404, message: 'Microsoft 登录当前未启用' },
  oauth_state_invalid: { status: 400, message: '登录状态已失效，请重新发起' },
  oauth_exchange_failed: { status: 502, message: 'Microsoft 授权失败，请重试' },
  oauth_no_email: { status: 400, message: '未能从 Microsoft 账户获取邮箱，无法登录' },
  oauth_subject_taken: { status: 409, message: '该 Microsoft 账户已绑定到其他用户' },
  oauth_email_taken: { status: 409, message: '该邮箱已被其他账户使用' },

  // --- 用户管理 ---
  user_not_found: { status: 404, message: '用户不存在' },
  cannot_modify_super: { status: 403, message: '不能修改超级管理员' },
  cannot_modify_self: { status: 403, message: '不能对自己执行此操作' },

  // --- 榜单条目 ---
  entry_not_found: { status: 404, message: '榜单条目不存在' },

  // --- 细分项目 ---
  category_exists: { status: 409, message: '该细分项目已存在' },
  category_not_found: { status: 404, message: '细分项目不存在' },

  // --- 数据库切换 ---
  db_connect_failed: { status: 502, message: '无法连接到目标数据库，请检查连接参数' },
  db_target_not_empty: { status: 409, message: '目标数据库中已有数据，请先清空或选择直接切换' },
  db_schema_mismatch: { status: 409, message: '目标数据库结构版本与当前不一致' },
  db_migration_failed: { status: 500, message: '目标数据库结构初始化失败' },
  db_copy_failed: { status: 500, message: '数据搬迁失败，已保持使用原数据库' },
  db_invalid_path: { status: 400, message: 'SQLite 文件路径不合法，必须位于 data/ 目录内' },
  db_switch_in_progress: { status: 409, message: '已有一个切换任务正在进行' }
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export function errorStatus(code: ErrorCode): number {
  return ERROR_CODES[code].status;
}

export function errorMessage(code: ErrorCode): string {
  return ERROR_CODES[code].message;
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && Object.hasOwn(ERROR_CODES, value);
}
