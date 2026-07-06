import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';
import { sendNodeResponse } from './sendNodeResponse';

/** 构造一个可被 pipe 的 mock ServerResponse，用闭包变量收集结果避免 getter/setter 冲突 */
function createMockRes() {
  const chunks: Buffer[] = [];
  const headers: Record<string, string | string[]> = {};
  const headerCalls: { name: string; value: string; append: boolean }[] = [];

  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk);
      callback();
    },
  });

  const res = stream as unknown as Writable & {
    statusCode: number;
    setHeader: (name: string, value: string) => void;
    appendHeader: (name: string, value: string) => void;
    writeHead: (status: number, h?: Record<string, string>) => void;
  };

  res.statusCode = 200;
  res.setHeader = (name, value) => {
    headers[name] = value;
    headerCalls.push({ name, value, append: false });
  };
  res.appendHeader = (name, value) => {
    const existing = headers[name];
    if (Array.isArray(existing)) existing.push(value);
    else if (existing !== undefined) headers[name] = [existing, value];
    else headers[name] = value;
    headerCalls.push({ name, value, append: true });
  };
  res.writeHead = (status, h) => {
    res.statusCode = status;
    if (h) Object.assign(headers, h);
  };

  return { res, chunks, headers, headerCalls };
}

describe('sendNodeResponse', () => {
  it('设置状态码', async () => {
    const { res } = createMockRes();
    const response = new Response('ok', { status: 201 });
    await sendNodeResponse(response, res as never);
    expect(res.statusCode).toBe(201);
  });

  it('设置普通 headers', async () => {
    const { res, headers } = createMockRes();
    const response = new Response('ok', { headers: { 'X-Custom': 'value' } });
    await sendNodeResponse(response, res as never);
    expect(headers['x-custom']).toBe('value');
  });

  it('set-cookie 使用 appendHeader 支持多值', async () => {
    const { res, headerCalls } = createMockRes();
    const response = new Response('ok', {
      headers: { 'Set-Cookie': 'a=1; b=2' },
    });
    await sendNodeResponse(response, res as never);
    const appendCalls = headerCalls.filter((c) => c.append);
    expect(appendCalls.length).toBeGreaterThan(0);
    expect(appendCalls.some((c) => c.name.toLowerCase() === 'set-cookie')).toBe(true);
  });

  it('body 为 null 时无内容写入', async () => {
    const { res, chunks } = createMockRes();
    const response = new Response(null, { status: 204 });
    await sendNodeResponse(response, res as never);
    expect(Buffer.concat(chunks).length).toBe(0);
  });

  it('有 body 时流式写入内容', async () => {
    const { res, chunks } = createMockRes();
    const response = new Response('hello world', { status: 200 });
    await sendNodeResponse(response, res as never);
    expect(Buffer.concat(chunks).toString()).toBe('hello world');
  });

  it('Content-Type header 被写入', async () => {
    const { res, headers } = createMockRes();
    const response = new Response('ok', {
      headers: { 'Content-Type': 'application/json' },
    });
    await sendNodeResponse(response, res as never);
    expect(headers['content-type']).toBe('application/json');
  });
});
