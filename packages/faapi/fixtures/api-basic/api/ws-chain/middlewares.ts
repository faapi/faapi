import type { FaapiMiddleware } from '@faapi/faapi';

// ws-chain 父级中间件：塞 ctx.tag = 'parent'
export default [
  async (ctx, next) => {
    (ctx as { tag?: string }).tag = 'parent';
    await next();
  },
] satisfies FaapiMiddleware[];
