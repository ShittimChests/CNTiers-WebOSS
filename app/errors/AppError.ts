import { ERROR_CODES, type ErrorCode } from './codes.js';

export interface AppErrorOptions {
  /** 覆盖码表默认文案；仅在需要携带动态信息（剩余次数、剩余秒数）时使用。 */
  message?: string;
  /** 结构化补充信息，供呈现层拼文案或 API 附加字段。 */
  meta?: Record<string, unknown>;
  cause?: unknown;
}

/**
 * 全站唯一的业务异常类型。路由与服务只抛它，呈现层据 code 决定
 * 渲染成 API JSON envelope 还是 SSR 页面 —— 见 web/middleware/errorHandler。
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly meta: Record<string, unknown>;

  constructor(code: ErrorCode, options: AppErrorOptions = {}) {
    const definition = ERROR_CODES[code];
    super(options.message ?? definition.message, { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.status = definition.status;
    this.meta = options.meta ?? {};
  }

  static is(value: unknown): value is AppError {
    return value instanceof AppError;
  }

  /** 公开 API 的错误信封，逐字段兼容旧实现：{ error, message }。 */
  toApiEnvelope(): { error: string; message: string } {
    return { error: this.code, message: this.message };
  }
}

/** 语法糖：throw fail('code') 比 throw new AppError('code') 短且更像断言。 */
export function fail(code: ErrorCode, options?: AppErrorOptions): never {
  throw new AppError(code, options);
}
