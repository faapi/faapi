/**
 * WebSocket fixture：握手中间件叠加测试
 *
 * 父级 ws-chain/middlewares.ts 塞 ctx.tag = 'parent'
 * 子级 ws-chain/inner/middlewares.ts 塞 ctx.tag = 'child'（覆盖父级）
 * WS handler 通过 WsContext.tag 读取最终值，验证父子中间件叠加执行
 */
import type { WsContext, WsEventHandlers } from '@faapi/faapi';

export function WS(ctx: WsContext): WsEventHandlers {
  return {
    onOpen(ws) {
      ws.send(`tag:${ctx.tag}`);
    },
  };
}
