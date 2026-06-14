/**
 * WebSocket fixture：动态路由 [id]
 *
 * 用于测试 WS 路由的动态参数提取。
 */
import type { WsContext, WsEventHandlers } from '@faapi/faapi';

export function WS(ctx: WsContext): WsEventHandlers {
  return {
    onOpen(ws) {
      ws.send({ roomId: ctx.params.id });
    },
    onMessage(ws, message) {
      ws.send(`room ${ctx.params.id}: ${message}`);
    },
  };
}
