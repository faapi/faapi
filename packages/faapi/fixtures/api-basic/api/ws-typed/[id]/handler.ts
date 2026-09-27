/**
 * WebSocket fixture：声明即校验验证
 *
 * 导出 WS 且同文件声明约定 interface（Params / Query）——握手阶段按声明类型
 * 校验并转换 params/query（失败拒绝握手），rawParams/rawQuery 恒为原始值。
 */
import type { WsContext, WsEventHandlers } from '@faapi/faapi';

export interface Params {
  id: number;
}

export interface Query {
  verbose: boolean;
}

export function WS(ctx: WsContext): WsEventHandlers {
  return {
    onOpen(ws) {
      ws.send(
        JSON.stringify({
          id: ctx.params.id,
          idType: typeof ctx.params.id,
          rawId: ctx.rawParams['id'],
          rawIdType: typeof ctx.rawParams['id'],
          verbose: ctx.query.verbose,
          verboseType: typeof ctx.query.verbose,
          rawVerbose: ctx.rawQuery.get('verbose'),
        }),
      );
    },
    onMessage(ws, message) {
      ws.send(`typed echo: ${message}`);
    },
  };
}
