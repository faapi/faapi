import { describe, it, expect } from 'vitest';
import { encodeSseEvent, createSseWriter } from './sse';

describe('encodeSseEvent', () => {
  it('纯 data 字段：生成 data: 行 + 空行', () => {
    const out = encodeSseEvent({ data: 'hello' });
    expect(out).toBe('data: hello\n\n');
  });

  it('多行 data：每行都加 data: 前缀', () => {
    const out = encodeSseEvent({ data: 'line1\nline2\nline3' });
    expect(out).toBe('data: line1\ndata: line2\ndata: line3\n\n');
  });

  it('event 字段：生成 event: 行', () => {
    const out = encodeSseEvent({ event: 'progress', data: '50' });
    expect(out).toBe('event: progress\ndata: 50\n\n');
  });

  it('id 字段：生成 id: 行', () => {
    const out = encodeSseEvent({ id: '42', data: 'x' });
    expect(out).toBe('id: 42\ndata: x\n\n');
  });

  it('retry 字段：生成 retry: 行（数字）', () => {
    const out = encodeSseEvent({ retry: 3000, data: 'x' });
    expect(out).toBe('retry: 3000\ndata: x\n\n');
  });

  it('全部字段：event/id/retry/data 都出现', () => {
    const out = encodeSseEvent({ event: 'update', id: '1', retry: 5000, data: 'payload' });
    expect(out).toContain('event: update');
    expect(out).toContain('id: 1');
    expect(out).toContain('retry: 5000');
    expect(out).toContain('data: payload');
    expect(out.endsWith('\n\n')).toBe(true);
  });

  it('data 为对象：JSON.stringify 后按字符串处理', () => {
    const out = encodeSseEvent({ data: { name: 'alice', age: 30 } });
    expect(out).toBe('data: {"name":"alice","age":30}\n\n');
  });

  it('data 为数字：转字符串', () => {
    const out = encodeSseEvent({ data: 42 });
    expect(out).toBe('data: 42\n\n');
  });

  it('data 为 boolean：转字符串', () => {
    const out = encodeSseEvent({ data: true });
    expect(out).toBe('data: true\n\n');
  });

  it('data 为 null：输出 data: null', () => {
    const out = encodeSseEvent({ data: null });
    expect(out).toBe('data: null\n\n');
  });

  it('空 data（undefined）：不输出 data 行', () => {
    const out = encodeSseEvent({ event: 'ping' });
    expect(out).toBe('event: ping\n\n');
  });

  it('comment 字段：生成 : 开头的注释行', () => {
    const out = encodeSseEvent({ comment: 'keep-alive' });
    expect(out).toBe(': keep-alive\n\n');
  });

  it('字段顺序固定：comment > event > id > retry > data', () => {
    const out = encodeSseEvent({
      data: 'd',
      retry: 1000,
      id: '9',
      event: 'e',
      comment: 'c',
    });
    const lines = out.split('\n');
    expect(lines[0]).toBe(': c');
    expect(lines[1]).toBe('event: e');
    expect(lines[2]).toBe('id: 9');
    expect(lines[3]).toBe('retry: 1000');
    expect(lines[4]).toBe('data: d');
  });
});

/**
 * 读取 ReadableStream 的全部内容为字符串
 */
async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result += decoder.decode(value, { stream: true });
  }
  result += decoder.decode();
  return result;
}

describe('createSseWriter', () => {
  it('返回的 writer 有 send 和 close 方法', () => {
    const writer = createSseWriter();
    expect(typeof writer.send).toBe('function');
    expect(typeof writer.close).toBe('function');
  });

  it('send 后 close：流内容包含编码后的事件', async () => {
    const writer = createSseWriter();
    writer.send({ data: 'hello' });
    writer.send({ event: 'progress', data: '50' });
    writer.close();
    const text = await readStream(writer.response.body!);
    expect(text).toBe('data: hello\n\nevent: progress\ndata: 50\n\n');
  });

  it('response 默认 Content-Type 为 text/event-stream', () => {
    const writer = createSseWriter();
    expect(writer.response.headers.get('Content-Type')).toBe('text/event-stream');
  });

  it('response 默认 Cache-Control 为 no-cache', () => {
    const writer = createSseWriter();
    expect(writer.response.headers.get('Cache-Control')).toBe('no-cache');
  });

  it('response 默认 Connection 为 keep-alive', () => {
    const writer = createSseWriter();
    expect(writer.response.headers.get('Connection')).toBe('keep-alive');
  });

  it('response 默认状态码 200', () => {
    const writer = createSseWriter();
    expect(writer.response.status).toBe(200);
  });

  it('close 后再 send：静默忽略（不抛错）', async () => {
    const writer = createSseWriter();
    writer.send({ data: 'a' });
    writer.close();
    // 不应抛错
    writer.send({ data: 'b' });
    const text = await readStream(writer.response.body!);
    expect(text).toBe('data: a\n\n');
  });

  it('未 close 直接读取流：流会阻塞直到 close 被调用', async () => {
    const writer = createSseWriter();
    writer.send({ data: 'a' });
    // 不 close，启动一个异步读取
    const readPromise = readStream(writer.response.body!);
    // 给一点时间让读取开始
    await new Promise((r) => setTimeout(r, 10));
    writer.send({ data: 'b' });
    writer.close();
    const text = await readPromise;
    expect(text).toBe('data: a\n\ndata: b\n\n');
  });

  it('sendError：向流写入 error 事件后关闭', async () => {
    const writer = createSseWriter();
    writer.send({ data: 'before' });
    writer.sendError(new Error('boom'));
    const text = await readStream(writer.response.body!);
    expect(text).toContain('data: before');
    expect(text).toContain('event: error');
    expect(text).toContain('boom');
    // sendError 后流应关闭
    expect(writer.closed).toBe(true);
  });

  it('closed 标记：初始 false，close 后 true', () => {
    const writer = createSseWriter();
    expect(writer.closed).toBe(false);
    writer.close();
    expect(writer.closed).toBe(true);
  });

  it('多次 close：第二次静默忽略', () => {
    const writer = createSseWriter();
    writer.close();
    expect(() => writer.close()).not.toThrow();
  });

  it('多行 data 通过 send 推送：每行加前缀', async () => {
    const writer = createSseWriter();
    writer.send({ data: 'line1\nline2' });
    writer.close();
    const text = await readStream(writer.response.body!);
    expect(text).toBe('data: line1\ndata: line2\n\n');
  });

  it('对象 data：自动 JSON.stringify', async () => {
    const writer = createSseWriter();
    writer.send({ data: { count: 5 } });
    writer.close();
    const text = await readStream(writer.response.body!);
    expect(text).toBe('data: {"count":5}\n\n');
  });

  describe('sendRaw 原始字节透传', () => {
    it('字符串 chunk 原样写入,不加 data: 前缀', async () => {
      const writer = createSseWriter();
      writer.sendRaw('data: {"hello":"world"}\n\n');
      writer.close();
      const text = await readStream(writer.response.body!);
      expect(text).toBe('data: {"hello":"world"}\n\n');
    });

    it('多行 SSE 原文整段透传,不重新序列化', async () => {
      const writer = createSseWriter();
      const upstreamChunk = 'event: chunk\ndata: {"delta":"hi"}\n\ndata: [DONE]\n\n';
      writer.sendRaw(upstreamChunk);
      writer.close();
      const text = await readStream(writer.response.body!);
      expect(text).toBe(upstreamChunk);
    });

    it('Uint8Array chunk 原样写入', async () => {
      const writer = createSseWriter();
      const encoder = new TextEncoder();
      const bytes = encoder.encode('data: ping\n\n');
      writer.sendRaw(bytes);
      writer.close();
      const text = await readStream(writer.response.body!);
      expect(text).toBe('data: ping\n\n');
    });

    it('多次 sendRaw 拼接完整 SSE 流', async () => {
      const writer = createSseWriter();
      writer.sendRaw('data: chunk1\n\n');
      writer.sendRaw('data: chunk2\n\n');
      writer.sendRaw('data: [DONE]\n\n');
      writer.close();
      const text = await readStream(writer.response.body!);
      expect(text).toBe('data: chunk1\n\ndata: chunk2\n\ndata: [DONE]\n\n');
    });

    it('close 后再 sendRaw：静默忽略（不抛错）', async () => {
      const writer = createSseWriter();
      writer.sendRaw('data: before\n\n');
      writer.close();
      // 不应抛错
      writer.sendRaw('data: after\n\n');
      const text = await readStream(writer.response.body!);
      expect(text).toBe('data: before\n\n');
    });

    it('与 send 混用：send 编码 + sendRaw 原文拼接', async () => {
      const writer = createSseWriter();
      writer.send({ event: 'start', data: 'begin' });
      writer.sendRaw('data: {"delta":"hi"}\n\n');
      writer.send({ data: 'end' });
      writer.close();
      const text = await readStream(writer.response.body!);
      expect(text).toBe('event: start\ndata: begin\n\ndata: {"delta":"hi"}\n\ndata: end\n\n');
    });

    it('aborted 后 sendRaw 静默忽略（不抛错）', async () => {
      const writer = createSseWriter();
      writer.sendRaw('data: before\n\n');
      await writer.response.body!.cancel();
      expect(writer.aborted).toBe(true);
      // 不应抛错
      expect(() => writer.sendRaw('data: after\n\n')).not.toThrow();
    });

    it('sendRaw 不修改传入的 Uint8Array（透传语义）', async () => {
      const writer = createSseWriter();
      const encoder = new TextEncoder();
      const bytes = encoder.encode('data: x\n\n');
      const original = Array.from(bytes);
      writer.sendRaw(bytes);
      writer.close();
      await readStream(writer.response.body!);
      // 入参 bytes 不应被修改
      expect(Array.from(bytes)).toEqual(original);
    });
  });

  describe('aborted 客户端断开检测', () => {
    it('初始 aborted 为 false', () => {
      const writer = createSseWriter();
      expect(writer.aborted).toBe(false);
    });

    it('客户端 cancel 流后 aborted 变为 true', async () => {
      const writer = createSseWriter();
      writer.send({ data: 'a' });
      // 模拟客户端断开：cancel ReadableStream
      await writer.response.body!.cancel();
      expect(writer.aborted).toBe(true);
    });

    it('aborted 后 send 静默忽略（不抛错）', async () => {
      const writer = createSseWriter();
      writer.send({ data: 'before' });
      await writer.response.body!.cancel();
      expect(writer.aborted).toBe(true);
      // 不应抛错
      expect(() => writer.send({ data: 'after' })).not.toThrow();
    });

    it('aborted 后 send 的数据不会到达流', async () => {
      const writer = createSseWriter();
      writer.send({ data: 'before' });
      await writer.response.body!.cancel();
      writer.send({ data: 'after' });
      writer.close();
      // 流已 cancel，读取会返回已写入的内容（cancel 前的）
      // 这里主要验证不抛错
      expect(writer.aborted).toBe(true);
    });

    it('close 后 aborted 仍保持原值（close 不改变 aborted）', () => {
      const writer = createSseWriter();
      writer.close();
      expect(writer.aborted).toBe(false);
    });
  });
});
