import type { FaapiMiddleware } from '@faapi/faapi';

// ws-auth 目录中间件：握手阶段鉴权
//
// 无 authorization 头：返回 401，握手被拦截，不进行协议升级
// 有 authorization 头：塞 ctx.user，WS handler 通过 WsContext.user 读取
export default [
  async (ctx, next) => {
    const token = ctx.headers.get('authorization');
    if (!token) {
      return new Response('Unauthorized', { status: 401 });
    }
    (ctx as { user?: unknown }).user = { name: 'alice' };
    await next();
  },
] satisfies FaapiMiddleware[];
