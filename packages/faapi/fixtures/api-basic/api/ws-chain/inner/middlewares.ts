import type { FaapiMiddleware } from '@faapi/faapi';

// ws-chain/inner 子级中间件：覆盖 ctx.tag = 'child'
export default [
  async (ctx, next) => {
    (ctx as { tag?: string }).tag = 'child';
    await next();
  },
] satisfies FaapiMiddleware[];
