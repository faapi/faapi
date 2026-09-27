import type { FaapiMiddleware } from '@faapi/faapi';

// order 目录中间件：在 handler 之前快照 ctx.params 的运行时类型——
// 管线已在中间件链之前按声明类型校验并回写 ctx.params，
// 中间件（与诊断日志）读到的 orderId 应已是 number 而非原始字符串
export default [
  async (ctx, next) => {
    (ctx as unknown as Record<string, unknown>).__orderMwSaw = {
      orderIdType: typeof (ctx.params as Record<string, unknown>)['orderId'],
    };
    await next();
  },
] satisfies FaapiMiddleware[];
