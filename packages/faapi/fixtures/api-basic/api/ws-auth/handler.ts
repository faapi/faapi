/**
 * WebSocket fixture：握手中间件链测试
 *
 * 配合 /api/ws-auth/middlewares.ts 验证握手阶段走洋葱中间件：
 * - 鉴权中间件无 token 返回 401，握手被拦截
 * - 鉴权中间件有 token 塞 ctx.user，WS handler 通过 WsContext.user 读取
 */
import type { WsContext, WsEventHandlers } from '@faapi/faapi';

export function WS(ctx: WsContext): WsEventHandlers {
  const user = ctx.user as { name: string } | undefined;
  return {
    onOpen(ws) {
      ws.send(`hello ${user?.name ?? 'anonymous'}`);
    },
  };
}
