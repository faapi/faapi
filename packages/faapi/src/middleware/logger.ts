import type { FaapiMiddleware } from './middlewareTypes';
import { isAccessLogPiped, writeLogEntry } from '../logger/logger';
import type { LogEntry, LogLevel } from '../logger/loggerTypes';

export type LoggerFn = (messageOrObj: string | Record<string, unknown>, message?: string) => void;

export interface LoggerOptions {
  /**
   * 自定义日志函数
   *
   * - 传入 `console.log`（默认）：纯文本格式 `GET /api/users 200 12ms`
   * - 传入 pino logger：结构化日志 `logger.info({ method, path, status, durationMs }, 'request completed')`
   * - 传入 winston logger：`logger.info('GET /api/users 200 12ms', { method, path })`
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

/** status → 日志级别映射（统一管道条目用）：5xx error、4xx warn、其余 info */
function levelForStatus(status: number): LogLevel {
  if (status >= 500) return 'error';
  if (status >= 400) return 'warn';
  return 'info';
}

/**
 * 默认输出函数（`options.log` 未配置时）
 *
 * 每次请求时动态解析（运行时切换 configureLogging 同样生效）：统一管道启用
 * （`config.log.dir` 缺省 / `accessLog: true`，见 logger.ts isAccessLogPiped）时
 * 转 LogEntry 经 writeLogEntry 并入（与业务日志同文件/同 sink，scope `access`）；
 * 否则 console.log 打印结构化条目（默认行为不变）。
 */
function defaultLog(entry: RequestLogEntry, text: string): void {
  if (isAccessLogPiped()) {
    const logEntry: LogEntry = {
      level: levelForStatus(entry.status),
      message: text,
      time: new Date().toISOString(),
      scope: 'access',
      fields: entry,
    };
    writeLogEntry(logEntry);
    return;
  }
  console.log(entry);
}

/**
 * 创建请求日志中间件（洋葱模型）
 *
 * 日志格式（文本模式）：GET /api/users 200 12ms
 * 错误格式（文本模式）：POST /api/users 400 45ms - Error: ...
 *
 * 结构化模式：传入 pino/winston 等 logger 实例时，会自动传递结构化字段。
 *
 * before/after 一体，闭包变量共享开始时间，无需污染 ctx。
 * 错误用 try/catch 捕获，记录后重新抛出（让上层处理）。
 * 成功时从 next() 返回的 Response 读取状态码。
 *
 * log 函数每次请求时读取（options.log ?? defaultLog），运行时替换 console.log 或
 * 切换全局日志配置均会生效。
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
