import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { MessageQueue, waitForWsOpen } from './wsTestClient';

/**
 * wsTestClient 单元测试：MessageQueue + waitForWsOpen 的纯逻辑测试
 *
 * 用 EventEmitter mock WebSocket，不启动真实 server。
 * E2E 集成测试见 wsTestClient.e2e.test.ts。
 */

class MockWebSocket extends EventEmitter {
  constructor() {
    super();
  }
}

describe('MessageQueue', () => {
  it('构造时立即注册 message 监听器，缓冲早到的消息', async () => {
    const ws = new MockWebSocket();
    const queue = new MessageQueue(ws as any);

    // 在 next() 调用前就 emit 'message'，模拟服务端 onOpen 同步推送
    ws.emit('message', Buffer.from('early-msg'));

    const msg = await queue.next(500);
    expect(msg).toBe('early-msg');
  });

  it('next() 在消息未到时等待，到达后 resolve', async () => {
    const ws = new MockWebSocket();
    const queue = new MessageQueue(ws as any);

    const promise = queue.next(500);
    // 稍后 emit
    setTimeout(() => ws.emit('message', Buffer.from('late-msg')), 20);

    const msg = await promise;
    expect(msg).toBe('late-msg');
  });

  it('FIFO 顺序消费多条消息', async () => {
    const ws = new MockWebSocket();
    const queue = new QueueTestHelper(new MessageQueue(ws as any));

    ws.emit('message', Buffer.from('msg-1'));
    ws.emit('message', Buffer.from('msg-2'));
    ws.emit('message', Buffer.from('msg-3'));

    expect(await queue.next(500)).toBe('msg-1');
    expect(await queue.next(500)).toBe('msg-2');
    expect(await queue.next(500)).toBe('msg-3');
  });

  it('超时未到消息 → reject', async () => {
    const ws = new MockWebSocket();
    const queue = new MessageQueue(ws as any);

    await expect(queue.next(50)).rejects.toThrow('WebSocket message timeout');
  });

  it('超时后 waiter 被清理，不污染后续 next()', async () => {
    const ws = new MockWebSocket();
    const queue = new MessageQueue(ws as any);

    await expect(queue.next(50)).rejects.toThrow();
    // 后续 next 应正常工作
    setTimeout(() => ws.emit('message', Buffer.from('after-timeout')), 20);
    const msg = await queue.next(500);
    expect(msg).toBe('after-timeout');
  });

  it('混合：先缓冲后等待再缓冲', async () => {
    const ws = new MockWebSocket();
    const queue = new MessageQueue(ws as any);

    ws.emit('message', Buffer.from('buffered-1'));
    expect(await queue.next(500)).toBe('buffered-1');

    setTimeout(() => ws.emit('message', Buffer.from('waited')), 20);
    expect(await queue.next(500)).toBe('waited');

    ws.emit('message', Buffer.from('buffered-2'));
    expect(await queue.next(500)).toBe('buffered-2');
  });

  it('非 Buffer 数据：转 string', async () => {
    const ws = new MockWebSocket();
    const queue = new MessageQueue(ws as any);
    // 模拟 ws 库传入 Uint8Array
    ws.emit('message', new Uint8Array([104, 105]) as any); // 'hi'

    const msg = await queue.next(500);
    expect(msg).toBe('hi');
  });

  it('Buffer[] 多帧数据：concat 后转 string', async () => {
    const ws = new MockWebSocket();
    const queue = new MessageQueue(ws as any);
    // 模拟 ws 库分片消息：[Buffer('hello'), Buffer(' world')]
    ws.emit('message', [Buffer.from('hello'), Buffer.from(' world')] as any);

    const msg = await queue.next(500);
    expect(msg).toBe('hello world');
  });

  it('ArrayBuffer 数据：转 string', async () => {
    const ws = new MockWebSocket();
    const queue = new MessageQueue(ws as any);
    // 模拟 ArrayBuffer
    const buf = new ArrayBuffer(2);
    const view = new Uint8Array(buf);
    view[0] = 104; // 'h'
    view[1] = 105; // 'i'
    ws.emit('message', buf as any);

    const msg = await queue.next(500);
    expect(msg).toBe('hi');
  });
});

describe('waitForWsOpen', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('open 事件触发 → resolve', async () => {
    const ws = new MockWebSocket();
    setTimeout(() => ws.emit('open'), 20);

    await expect(waitForWsOpen(ws as any, 500)).resolves.toBeUndefined();
  });

  it('error 事件触发 → reject(err)', async () => {
    const ws = new MockWebSocket();
    const err = new Error('connection refused');
    setTimeout(() => ws.emit('error', err), 20);

    await expect(waitForWsOpen(ws as any, 500)).rejects.toThrow('connection refused');
  });

  it('close 事件触发 → reject("closed before open")', async () => {
    const ws = new MockWebSocket();
    setTimeout(() => ws.emit('close'), 20);

    await expect(waitForWsOpen(ws as any, 500)).rejects.toThrow('WebSocket closed before open');
  });

  it('超时 → reject("open timeout") + 清理 timer', async () => {
    const ws = new MockWebSocket();
    // 不 emit 任何事件，等超时
    await expect(waitForWsOpen(ws as any, 50)).rejects.toThrow('WebSocket open timeout');
    // 超时后 emit open 不应触发任何未捕获异常（listener 已清理）
    ws.emit('open');
  });

  it('open 优先于超时：clearTimeout 后 timer 不再触发', async () => {
    const ws = new MockWebSocket();
    setTimeout(() => ws.emit('open'), 10);

    // timeout 设为 100ms，open 在 10ms 触发
    await expect(waitForWsOpen(ws as any, 100)).resolves.toBeUndefined();
    // 等待超时时间过去，确认无未捕获异常
    await new Promise((r) => setTimeout(r, 150));
  });
});

/**
 * 测试 helper：把 queue.next 包成同步可调用形式（仅为类型便利）
 */
class QueueTestHelper {
  constructor(private queue: MessageQueue) {}
  next(timeout?: number): Promise<string> {
    return this.queue.next(timeout);
  }
}
