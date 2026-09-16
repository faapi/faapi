import type { FaapiMiddleware } from './middlewareTypes';
import { isAccessLogEnabled, writeLogEntry } from '../logger/logger';
import type { LogLevel } from '../logger/loggerTypes';

export type LoggerFn = (messageOrObj: string | Record<string, unknown>, message?: string) => void;

export interface LoggerOptions {
  /**
   * 自定义日志函数（完全接管输出，不再走统一管道——高级用法，一般无需配置）
   *
   * - 传入 `console.log`：纯文本格式 `GET /api/users 200 12ms`
   * - 传入 pino logger：结构化日志 `logger.info({ method, path, status, durationMs }, 'request completed')`
   */
  log?: LoggerFn;
}

/** 请求日志条目（自定义 log 函数的第一参数；index 签名兼容 LoggerFn 的 Record 形参） */
interface RequestLogEntry {
  [key: string]: unknown;
  requestId: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  error?: string;
}

/** status → 日志级别映射（管道条目用）：5xx error、4xx warn、其余 info */
function levelForStatus(status: number): LogLevel {
  if (status >= 500) return 'error';
  if (status >= 400) return 'warn';
  return 'info';
}

/**
 * 默认输出（`options.log` 未配置时）：请求日志无条件并入统一日志管道
 *
 * 条目转 LogEntry 经 writeLogEntry 输出（scope `access`，fields 携带
 * requestId/method/path/status/durationMs）——与业务日志同文件/同 sink/console，
 * 受 `config.log.level`（管道阈值）与 `consoleLevel`（console 出口）统一过滤。
 * `config.log.accessLog: false` 或 `config.log: false` 时丢弃不输出。
 */
function defaultLog(entry: RequestLogEntry, text: string): void {
  if (!isAccessLogEnabled()) return;
  writeLogEntry({
    level: levelForStatus(entry.status),
    message: text,
    time: new Date().toISOString(),
    scope: 'access',
    fields: entry,
  });
}

/**
 * 创建请求日志中间件（洋葱模型）
 *
 * 默认并入统一日志管道（egg 模型：访问日志与业务日志同管道，一份 config.log
 * 管全部输出），`config.log.accessLog: false` 关闭。
 *
 * 日志格式（文本 message）：GET /api/users 200 12ms
 * 错误格式：POST /api/users 400 45ms - Error: ...
 *
 * before/after 一体，闭包变量共享开始时间，无需污染 ctx。
 * 错误用 try/catch 捕获，记录后重新抛出（让上层处理）。
 * 成功时从 next() 返回的 Response 读取状态码。
 *
 * log 函数每次请求时读取（options.log ?? defaultLog），运行时切换全局日志配置
 * 同样生效。编程式自定义输出：`middlewares: [logger({ log: myFn })]`。
 */
export function logger(options: LoggerOptions = {}): FaapiMiddleware {
  return async (ctx, next) => {
    const log = options.log ?? defaultLog;
    const start = Date.now();
    try {
      const response = await next();
      const duration = Date.now() - start;
      const entry = {
        requestId: ctx.requestId,
        method: ctx.method,
        path: ctx.path,
        status: response.status,
        durationMs: duration,
      };
      log(entry, `${ctx.method} ${ctx.path} ${response.status} ${duration}ms`);
      return response;
    } catch (err) {
      const duration = Date.now() - start;
      const message = err instanceof Error ? err.message : String(err);
      const status = (err as { statusCode?: number })?.statusCode ?? 500;
      const entry = {
        requestId: ctx.requestId,
        method: ctx.method,
        path: ctx.path,
        status,
        durationMs: duration,
        error: message,
      };
      log(entry, `${ctx.method} ${ctx.path} ${status} ${duration}ms - ${message}`);
      throw err;
    }
  };
}
