import type { FaapiMiddleware } from './middlewareTypes';

export interface LoggerOptions {
  /** 自定义日志输出函数，默认 console.log */
  log?: (message: string) => void;
}

/**
 * 创建请求日志中间件（洋葱模型）
 *
 * 日志格式：GET /api/users 200 12ms
 * 错误格式：POST /api/users 400 45ms - Error: ...
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
      log(`${ctx.method} ${ctx.path} ${response.status} ${duration}ms`);
      return response;
    } catch (err) {
      const duration = Date.now() - start;
      const message = err instanceof Error ? err.message : String(err);
      // 从错误对象获取实际状态码（FaapiError 有 statusCode 字段），默认 500
      const status = (err as { statusCode?: number })?.statusCode ?? 500;
      log(`${ctx.method} ${ctx.path} ${status} ${duration}ms - ${message}`);
      throw err; // 重新抛出，让上层处理
    }
  };
}
