import { describe, it, expect, vi, afterEach } from 'vitest';
import { createTaskQueue } from './taskQueue';
import { createTaskRegistry } from './taskRegistry';
import type { TaskModule } from './taskTypes';

afterEach(() => {
  vi.useRealTimers();
});

function makeDeps(modules: Record<string, TaskModule>, schemas: Record<string, unknown> = {}) {
  const registry = createTaskRegistry();
  registry.hydrate(
    Object.keys(modules).map((name) => ({
      name,
      filePath: `dist/tasks/${name}/task.js`,
    })),
  );
  const loadTaskModule = vi.fn(async (filePath: string) => {
    const name = filePath.match(/tasks\/([^/]+)\/task\.js/)?.[1] ?? '';
    return modules[name]!;
  });
  const loadPayloadSchema = vi.fn(async (filePath: string) => {
    const name = filePath.match(/tasks\/([^/]+)\/task\.js/)?.[1] ?? '';
    return schemas[name];
  });
  return { registry, rootDir: '/fake', loadTaskModule, loadPayloadSchema };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe('createTaskQueue', () => {
  it('enqueue 后自动执行 run，返回任务 id，状态变 done', async () => {
    const run = vi.fn(async () => 'ok');
    const deps = makeDeps({ hello: { run } });
    const queue = createTaskQueue(deps);
    queue.start();

    const { id } = await queue.enqueue('hello', { a: 1 });
    expect(id).toBeTruthy();
    await vi.waitFor(() => {
      expect(run).toHaveBeenCalledTimes(1);
    });
    const job = queue.list('hello')[0]!;
    expect(job.status).toBe('done');
    expect(job.result).toBe('ok');
    expect(job.payload).toEqual({ a: 1 });
    await queue.stop();
  });

  it('payload 校验失败抛 ValidationError 且不入队', async () => {
    const zodLike = {
      safeParse: (_v: unknown) => ({
        success: false,
        error: { issues: [{ code: 'invalid_type', path: ['to'], message: 'Required' }] },
      }),
    };
    const deps = makeDeps({ mail: { run: vi.fn() } }, { mail: zodLike });
    const queue = createTaskQueue(deps);
    queue.start();
    await expect(queue.enqueue('mail', { wrong: 1 })).rejects.toThrow();
    expect(queue.list('mail')).toHaveLength(0);
    await queue.stop();
  });

  it('payload 校验通过后正常入队执行', async () => {
    const zodLike = { safeParse: (v: unknown) => ({ success: true, data: v }) };
    const run = vi.fn(async () => null);
    const deps = makeDeps({ mail: { run } }, { mail: zodLike });
    const queue = createTaskQueue(deps);
    queue.start();
    await queue.enqueue('mail', { to: 'a@b.c' });
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect((run.mock.calls[0] as unknown[])[0]).toEqual({ to: 'a@b.c' });
    await queue.stop();
  });

  it('入队不存在的任务抛错并提示可用任务名', async () => {
    const deps = makeDeps({ a: { run: vi.fn() } });
    const queue = createTaskQueue(deps);
    queue.start();
    await expect(queue.enqueue('nope', {})).rejects.toThrow(/nope/);
    await queue.stop();
  });

  it('失败按 retries 重试，退避后成功记 done', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const run = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw new Error('boom');
      return 'finally';
    });
    const registry = createTaskRegistry();
    registry.hydrate([{ name: 'flaky', filePath: 'dist/tasks/flaky/task.js', retries: 3 }]);
    const queue = createTaskQueue({
      registry,
      rootDir: '/fake',
      loadTaskModule: async () => ({ run }),
      loadPayloadSchema: async () => undefined,
    });
    queue.start();
    await queue.enqueue('flaky');

    await vi.advanceTimersByTimeAsync(0); // 第一次执行（失败）
    await vi.advanceTimersByTimeAsync(500); // 第 1 次重试（500ms，失败）
    await vi.advanceTimersByTimeAsync(1000); // 第 2 次重试（1000ms，成功）
    const job = queue.list('flaky')[0]!;
    expect(job.attempts).toBe(3);
    expect(job.status).toBe('done');
    expect(job.result).toBe('finally');
    await queue.stop();
  });

  it('重试次数耗尽记 failed 并保留 error', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => {
      throw new Error('always fails');
    });
    const registry = createTaskRegistry();
    registry.hydrate([{ name: 'bad', filePath: 'dist/tasks/bad/task.js', retries: 1 }]);
    const queue = createTaskQueue({
      registry,
      rootDir: '/fake',
      loadTaskModule: async () => ({ run }),
      loadPayloadSchema: async () => undefined,
    });
    queue.start();
    await queue.enqueue('bad');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(500);
    const job = queue.list('bad')[0]!;
    expect(job.status).toBe('failed');
    expect(job.error).toBe('always fails');
    expect(run).toHaveBeenCalledTimes(2);
    await queue.stop();
  });

  it('concurrency 限制同任务并行数', async () => {
    let running = 0;
    let maxRunning = 0;
    const run = vi.fn(async () => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setTimeout(r, 20));
      running -= 1;
    });
    const registry = createTaskRegistry();
    registry.hydrate([{ name: 'wide', filePath: 'dist/tasks/wide/task.js', concurrency: 2 }]);
    const queue = createTaskQueue({
      registry,
      rootDir: '/fake',
      loadTaskModule: async () => ({ run }),
      loadPayloadSchema: async () => undefined,
    });
    queue.start();
    await Promise.all([queue.enqueue('wide'), queue.enqueue('wide'), queue.enqueue('wide')]);
    await vi.waitFor(() => {
      expect(queue.list('wide').every((j) => j.status === 'done')).toBe(true);
    });
    expect(maxRunning).toBe(2);
    await queue.stop();
  });

  it('任务模块缺失 run 记 failed，不崩溃', async () => {
    const deps = makeDeps({ empty: {} });
    const queue = createTaskQueue(deps);
    queue.start();
    await queue.enqueue('empty');
    await vi.waitFor(() => {
      expect(queue.list('empty')[0]!.status).toBe('failed');
    });
    await queue.stop();
  });

  it('stop 等待在跑任务完成后返回（drain）', async () => {
    let finished = false;
    const run = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 30));
      finished = true;
    });
    const deps = makeDeps({ slow: { run } });
    const queue = createTaskQueue(deps);
    queue.start();
    await queue.enqueue('slow');
    await vi.waitFor(() => expect(queue.list('slow')[0]!.status).toBe('running'));
    await queue.stop();
    expect(finished).toBe(true);
    // 停止后不再接受新任务
    await expect(queue.enqueue('slow', {})).rejects.toThrow();
  });

  it('list 不传 name 返回全部任务记录', async () => {
    const deps = makeDeps({
      a: { run: async () => 1 },
      b: { run: async () => 2 },
    });
    const queue = createTaskQueue(deps);
    queue.start();
    await queue.enqueue('a');
    await queue.enqueue('b');
    await flush();
    await vi.waitFor(() => expect(queue.list()).toHaveLength(2));
    await queue.stop();
  });

  it('注入自定义 TaskDriver：enqueue 透传 retries，worker 注册并发，process 由驱动调用', async () => {
    const calls: Array<{ name: string; payload: unknown; retries?: number }> = [];
    const started = new Map<string, { concurrency: number }>();
    // 极简 fake 驱动：startWorker 后手动调用 process（真实重试逻辑由具体驱动负责）
    const driver = {
      enqueue: async (name: string, payload: unknown, opts?: { retries?: number }) => {
        calls.push({ name, payload, retries: opts?.retries });
        return `ext-${calls.length}`;
      },
      startWorker: (
        name: string,
        opts: {
          concurrency: number;
          process: (job: {
            id: string;
            name: string;
            payload: unknown;
            attempt: number;
            signal: AbortSignal;
          }) => Promise<unknown>;
        },
      ) => {
        started.set(name, { concurrency: opts.concurrency });
        void opts
          .process({
            id: `ext-${name}-1`,
            name,
            payload: { ok: true },
            attempt: 1,
            signal: new AbortController().signal,
          })
          .catch(() => {});
      },
      stop: async () => {},
      stopWorkers: async () => {},
    };
    const registry = createTaskRegistry();
    registry.hydrate([
      { name: 'ext', filePath: 'dist/tasks/ext/task.js', retries: 5, concurrency: 3 },
    ]);
    const processRun = vi.fn(async () => 'done');
    const queue = createTaskQueue({
      registry,
      rootDir: '/fake',
      driver: driver as never,
      loadTaskModule: async () => ({ run: processRun }),
      loadPayloadSchema: async () => undefined,
    });
    await queue.start();
    expect(started.get('ext')).toEqual({ concurrency: 3 });
    await queue.enqueue('ext', { ok: true });
    expect(calls[0]).toMatchObject({ name: 'ext', retries: 5 });
    await vi.waitFor(() => expect(processRun).toHaveBeenCalledTimes(1));
    expect(queue.list('ext')[0]).toMatchObject({ id: 'ext-ext-1', status: 'done', result: 'done' });
    // reload 重注册 worker（dev 热替换路径）
    await queue.reload();
    await queue.stop();
  });
});
