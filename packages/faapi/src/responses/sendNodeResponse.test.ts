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

  describe('客户端断连', () => {
    /** 构造带 cancel 探针的流式 Response */
    function streamingResponse(onCancel: () => void): Response {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('chunk-1'));
          controller.enqueue(new TextEncoder().encode('chunk-2'));
        },
        cancel() {
          onCancel();
        },
      });
      return new Response(stream, { status: 200 });
    }

    it('res 提前 close 时销毁源流（触发 cancel）并正常 resolve，不 reject', async () => {
      let cancelled = false;
      const mock = createMockRes();
      // 模拟半双工 mock：首个 chunk 后断开连接（close 且 writableEnded=false）
      const stream = mock.res as unknown as Writable;
      stream.on('pipe', () => {
        process.nextTick(() => stream.destroy());
      });

      await expect(
        sendNodeResponse(
          streamingResponse(() => (cancelled = true)),
          mock.res as never,
        ),
      ).resolves.toBeUndefined();
      // 源流被销毁 → 底层 web ReadableStream 的 cancel 被触发（SseWriter.aborted 置位的路径）
      expect(cancelled).toBe(true);
    });

    it("res 'error'（ECONNRESET）时同样按断连处理，不 reject", async () => {
      let cancelled = false;
      const mock = createMockRes();
      const stream = mock.res as unknown as Writable;
      stream.on('pipe', () => {
        process.nextTick(() => stream.destroy(new Error('ECONNRESET')));
      });

      await expect(
        sendNodeResponse(
          streamingResponse(() => (cancelled = true)),
          mock.res as never,
        ),
      ).resolves.toBeUndefined();
      expect(cancelled).toBe(true);
    });

    it('源流自身错误仍 reject（走错误响应路径）', async () => {
      const { res } = createMockRes();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('partial'));
          controller.error(new Error('handler stream boom'));
        },
      });
      await expect(sendNodeResponse(new Response(stream), res as never)).rejects.toThrow(
        'handler stream boom',
      );
    });
  });
});
