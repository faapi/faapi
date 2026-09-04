import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRebuildScheduler, type RebuildScheduler } from './rebuildScheduler';

/** 手动 resolve 的 deferred promise，用于控制 rebuild 完成时机 */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: unknown) => void } {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('createRebuildScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('debounce 合并：窗口内多次 addFiles 只跑一轮，回调收到全部文件', async () => {
    const rebuild = vi.fn().mockResolvedValue(undefined);
    const scheduler = createRebuildScheduler({ rebuild });

    scheduler.addFiles(['/a.ts']);
    vi.advanceTimersByTime(50);
    scheduler.addFiles(['/b.ts']);
    vi.advanceTimersByTime(50);
    scheduler.addFiles(['/c.ts']);

    // 第三次 add 重置了 debounce 窗口，再推进 100ms 触发
    await vi.advanceTimersByTimeAsync(100);

    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(rebuild).toHaveBeenCalledWith(['/a.ts', '/b.ts', '/c.ts']);
  });

  it('重建期间新事件不并发触发第二轮，当前轮结束后自动补一轮', async () => {
    const first = deferred();
    const rebuild = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(undefined);
    const scheduler = createRebuildScheduler({ rebuild });

    scheduler.addFiles(['/a.ts']);
    await vi.advanceTimersByTimeAsync(100);
    expect(rebuild).toHaveBeenCalledTimes(1);

    // 第一轮还在进行中，此时新文件事件到来
    scheduler.addFiles(['/b.ts']);
    await vi.advanceTimersByTimeAsync(500);
    // 未并发：第一轮未结束前不触发第二轮
    expect(rebuild).toHaveBeenCalledTimes(1);

    // 第一轮结束 → 自动补一轮（带上重建期间累积的文件）
    first.resolve();
    await vi.advanceTimersByTimeAsync(0);

    expect(rebuild).toHaveBeenCalledTimes(2);
    expect(rebuild).toHaveBeenLastCalledWith(['/b.ts']);
  });

  it('重建期间多次 schedule 只补一轮', async () => {
    const first = deferred();
    const rebuild = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(undefined);
    const scheduler = createRebuildScheduler({ rebuild });

    scheduler.addFiles(['/a.ts']);
    await vi.advanceTimersByTimeAsync(100);
    expect(rebuild).toHaveBeenCalledTimes(1);

    scheduler.schedule();
    scheduler.schedule();
    scheduler.schedule();

    first.resolve();
    await vi.advanceTimersByTimeAsync(0);

    expect(rebuild).toHaveBeenCalledTimes(2);
    expect(rebuild).toHaveBeenLastCalledWith([]);
  });

  it('补跑轮次结束后若又有事件，继续串行补跑', async () => {
    const first = deferred();
    const rebuild = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockImplementationOnce(() => new Promise(() => {})) // 第二轮挂起（never resolve）
      .mockResolvedValue(undefined);
    const scheduler = createRebuildScheduler({ rebuild });

    scheduler.addFiles(['/a.ts']);
    await vi.advanceTimersByTimeAsync(100);

    scheduler.addFiles(['/b.ts']);
    first.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(rebuild).toHaveBeenCalledTimes(2); // 补跑第一轮

    scheduler.addFiles(['/c.ts']);
    await vi.advanceTimersByTimeAsync(500);
    // 第二轮挂起中，不并发
    expect(rebuild).toHaveBeenCalledTimes(2);
  });

  it('rebuild 抛错：文件回灌，不主动重试；下次 addFiles 触发时带上回灌文件', async () => {
    const rebuild = vi.fn().mockRejectedValueOnce(new Error('compile failed'));
    const onError = vi.fn();
    const scheduler: RebuildScheduler = createRebuildScheduler({ rebuild, onError });

    scheduler.addFiles(['/a.ts']);
    scheduler.addFiles(['/b.ts']);
    await vi.advanceTimersByTimeAsync(100);

    // 错误上报
    expect(onError).toHaveBeenCalledTimes(1);

    // 失败后不主动重试
    await vi.advanceTimersByTimeAsync(1000);
    expect(rebuild).toHaveBeenCalledTimes(1);

    // 下次事件触发时带上回灌的文件
    scheduler.addFiles(['/c.ts']);
    await vi.advanceTimersByTimeAsync(100);
    expect(rebuild).toHaveBeenLastCalledWith(['/a.ts', '/b.ts', '/c.ts']);
  });

  it('rebuild 成功：文件清空不回灌，后续 schedule 收到空数组', async () => {
    const rebuild = vi.fn().mockResolvedValue(undefined);
    const scheduler = createRebuildScheduler({ rebuild });

    scheduler.addFiles(['/a.ts']);
    await vi.advanceTimersByTimeAsync(100);
    expect(rebuild).toHaveBeenLastCalledWith(['/a.ts']);

    scheduler.schedule();
    await vi.advanceTimersByTimeAsync(100);
    expect(rebuild).toHaveBeenLastCalledWith([]);
  });

  it('自定义 debounce 窗口', async () => {
    const rebuild = vi.fn().mockResolvedValue(undefined);
    const scheduler = createRebuildScheduler({ rebuild, debounceMs: 300 });

    scheduler.addFiles(['/a.ts']);
    await vi.advanceTimersByTimeAsync(100);
    expect(rebuild).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(200);
    expect(rebuild).toHaveBeenCalledTimes(1);
  });
});
