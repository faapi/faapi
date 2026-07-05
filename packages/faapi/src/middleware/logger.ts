import type { FaapiMiddleware } from './middlewareTypes';

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
 */
export function logger(options: LoggerOptions = {}): FaapiMiddleware {
  const { log = console.log } = options;

  return async (ctx, next) => {
    const start = Date.now();
    try {
      const response = await next();
      const duration = Date.now() - start;
      const entry = {
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
