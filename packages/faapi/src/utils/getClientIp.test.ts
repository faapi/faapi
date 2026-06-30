import { describe, it, expect } from 'vitest';
import { getClientIp } from './getClientIp';
import type { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';

function makeReq(
  opts: { xff?: string; remoteAddress?: string } = {},
): IncomingMessage {
  const socket = new Socket();
  // 模拟 remoteAddress
  Object.defineProperty(socket, 'remoteAddress', {
    value: opts.remoteAddress,
    configurable: true,
  });
  const req = {
    headers: opts.xff ? { 'x-forwarded-for': opts.xff } : {},
    socket,
  } as unknown as IncomingMessage;
  return req;
}

describe('getClientIp', () => {
  it('x-forwarded-for 优先，取第一个 IP', () => {
    const req = makeReq({ xff: '203.0.113.1, 10.0.0.1', remoteAddress: '127.0.0.1' });
    expect(getClientIp(req)).toBe('203.0.113.1');
  });

  it('x-forwarded-for trim 空白', () => {
    const req = makeReq({ xff: '  203.0.113.2  , 10.0.0.1' });
    expect(getClientIp(req)).toBe('203.0.113.2');
  });

  it('无 x-forwarded-for 时用 socket.remoteAddress', () => {
    const req = makeReq({ remoteAddress: '127.0.0.1' });
    expect(getClientIp(req)).toBe('127.0.0.1');
  });

  it('IPv6 ::ffff: 前缀去掉', () => {
    const req = makeReq({ remoteAddress: '::ffff:192.168.1.1' });
    expect(getClientIp(req)).toBe('192.168.1.1');
  });

  it('IPv6 地址原样返回', () => {
    const req = makeReq({ remoteAddress: '::1' });
    expect(getClientIp(req)).toBe('::1');
  });

  it('两者都无返回空字符串', () => {
    const req = makeReq({});
    expect(getClientIp(req)).toBe('');
  });

  it('x-forwarded-for 空字符串回退到 socket', () => {
    const req = makeReq({ xff: '', remoteAddress: '127.0.0.1' });
    expect(getClientIp(req)).toBe('127.0.0.1');
  });
});
