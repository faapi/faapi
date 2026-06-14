import type { FaapiMiddleware, InjectorMap } from '@faapi/faapi';

// admin 目录通用中间件：错误处理
export default [
  // 错误处理：try/catch 捕获内层错误
  async (_ctx, next) => {
    try {
      await next();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return new Response(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message } }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  },
] satisfies FaapiMiddleware[];

// admin 目录通用注入器
export const injectors: InjectorMap = {
  db: () => ({ connected: true, query: (sql: string) => `result:${sql}` }),
};
