import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../../errors/AppError.js';

/**
 * 维护模式。切库期间用来挡住写请求：读请求继续走旧库（数据仍然一致），
 * 写请求返回 503，避免在复制过程中产生只写进旧库的新数据。
 *
 * 状态放模块级变量：切库是单进程内的操作，不需要跨进程协调。
 */

let reason: string | null = null;

export function enterMaintenance(why: string): void {
  reason = why;
  console.info(`进入维护模式：${why}`);
}

export function exitMaintenance(): void {
  if (reason !== null) console.info('已退出维护模式');
  reason = null;
}

export function maintenanceReason(): string | null {
  return reason;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function blockWritesDuringMaintenance(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  if (reason === null || SAFE_METHODS.has(req.method)) {
    next();
    return;
  }
  next(new AppError('maintenance', { meta: { reason } }));
}
