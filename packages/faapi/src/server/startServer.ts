import type { Server } from 'node:http';
import type { RequestHandler, UpgradeHandler } from '../config/pluginTypes';

/**
 * 应用 handler / upgrade 包装器到 server
 *
 * 在 server.listen 之前调用，替换 server 的 request/upgrade listener。
 * 包装器按数组顺序嵌套：finalHandler = wrap1(wrap2(originalHandler))。
 *
 * @param server 目标 server（未 listen）
 * @param handlerWrappers HTTP handler 包装器数组
 * @param upgradeWrappers WS upgrade handler 包装器数组
 */
export function applyPluginWrappers(
  server: Server,
  handlerWrappers: Array<(original: RequestHandler) => RequestHandler>,
  upgradeWrappers: Array<(original: UpgradeHandler | undefined) => UpgradeHandler>,
): void {
  // 应用 HTTP handler 包装
  if (handlerWrappers.length > 0) {
    const listeners = server.listeners('request');
    const original = listeners[0] as RequestHandler | undefined;
    if (original) {
      server.removeAllListeners('request');
      let handler: RequestHandler = original;
      for (const wrap of handlerWrappers) {
        handler = wrap(handler);
      }
      server.on('request', handler);
    }
  }

  // 应用 WS upgrade handler 包装
  if (upgradeWrappers.length > 0) {
    const listeners = server.listeners('upgrade');
    const original = listeners[0] as UpgradeHandler | undefined;
    server.removeAllListeners('upgrade');
    let upgrade: UpgradeHandler | undefined = original;
    for (const wrap of upgradeWrappers) {
      upgrade = wrap(upgrade);
    }
    if (upgrade) {
      server.on('upgrade', upgrade);
    }
  }
}
