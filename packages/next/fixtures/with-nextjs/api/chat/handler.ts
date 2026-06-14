import type { WsContext, WsEventHandlers } from '@faapi/faapi';

export function WS(ctx: WsContext): WsEventHandlers {
  return {
    onOpen(ws) {
      ws.send(JSON.stringify({ source: 'faapi-ws', connected: true }));
    },
    onMessage(ws, message) {
      ws.send(JSON.stringify({ source: 'faapi-ws', echo: String(message) }));
    },
  };
}
