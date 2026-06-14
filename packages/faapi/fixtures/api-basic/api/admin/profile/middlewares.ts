import type { FaapiMiddleware, InjectorMap } from '@faapi/faapi';

// profile 专属中间件：鉴权（无 token 拦截，有 token 塞 user 到 ctx）
export default [
  async (ctx, next) => {
    const token = ctx.headers.get('authorization');
    if (!token) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    (ctx as { user?: unknown }).user = { name: 'alice', role: 'admin' };
    await next();
  },
] satisfies FaapiMiddleware[];

// profile 专属注入器：从 ctx 取 user
export const injectors: InjectorMap = {
  user: (ctx) => (ctx as { user?: unknown }).user,
};
