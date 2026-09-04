import type { IncomingMessage } from 'node:http';

/**
 * 从 IncomingMessage 提取客户端 IP
 *
 * 优先级：
 * 1. `trustedProxy=true` 时,`x-forwarded-for` 第一个 IP（反向代理场景，如 nginx/CDN）
 * 2. `req.socket.remoteAddress`（直连场景,默认路径）
 *
 * `x-forwarded-for` 格式：`client, proxy1, proxy2`，取第一个即客户端真实 IP。
 *
 * **默认不信任该 header**（`trustedProxy=false`）：客户端直连时 XFF 可被任意伪造，
 * 污染 `ctx.ip`（影响限流/日志/风控）。部署在受信任的反向代理之后时，通过
 * `faapi.config.ts` 的 `trustedProxy: true` 显式开启。
 *
 * @param trustedProxy 是否信任反向代理头（默认 false——安全默认,直连不可伪造）
 * @returns 客户端 IP，无法获取时返回空字符串
 */
export function getClientIp(req: IncomingMessage, trustedProxy = false): string {
  // 1. x-forwarded-for（仅显式信任反向代理时）
  if (trustedProxy) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.length > 0) {
      const first = xff.split(',')[0]?.trim();
      if (first) return first;
    }
  }

  // 2. 直连 socket IP
  const remote = req.socket?.remoteAddress;
  if (remote) {
    // 去掉 IPv6 前缀 ::ffff:，统一返回 IPv4 形式
    if (remote.startsWith('::ffff:')) {
      return remote.slice(7);
    }
    return remote;
  }

  return '';
}
