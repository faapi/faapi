/**
 * WebSocket fixture：导出 WS 函数
 *
 * 用于 scanRoutes 的 WS 路由扫描测试和 createServer 的 e2e 测试。
 */
import type { WsContext, WsEventHandlers } from '@faapi/faapi';

export function WS(ctx: WsContext): WsEventHandlers {
  return {
    onOpen(ws) {
      ws.send('connected');
    },
    onMessage(ws, message) {
      ws.send(`echo: ${message}`);
    },
    onClose() {
      // 测试 fixture 无需副作用
    },
    onError() {
      // 测试 fixture 无需副作用
    },
  };
}
