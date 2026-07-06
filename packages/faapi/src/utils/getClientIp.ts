import type { IncomingMessage } from 'node:http';

/**
 * 从 IncomingMessage 提取客户端 IP
 *
 * 优先级：
 * 1. `x-forwarded-for` 第一个 IP（反向代理场景，如 nginx/CDN）
 * 2. `req.socket.remoteAddress`（直连场景）
 *
 * `x-forwarded-for` 格式：`client, proxy1, proxy2`，取第一个即客户端真实 IP。
 * 注意：仅在受信任的反向代理后才有效；若客户端直连且未经过代理，该 header 可被伪造。
 *
 * @returns 客户端 IP，无法获取时返回空字符串
 */
export function getClientIp(req: IncomingMessage): string {
  // 1. x-forwarded-for 优先（反向代理场景）
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
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
