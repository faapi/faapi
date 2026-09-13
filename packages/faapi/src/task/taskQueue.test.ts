import { describe, it, expect, vi } from 'vitest';
import { createTaskQueue } from './taskQueue';
import { createTaskRegistry } from './taskRegistry';
import type { TaskDriver, TaskDriverJob, TaskDriverProcess } from './driverTypes';
import type { TaskModule } from './taskTypes';

interface EnqueueCall {
  name: string;
  payload: unknown;
  opts?: { delayMs?: number; retries?: number };
}

/**
 * 可编程测试驱动：记录 enqueue/startWorker/stop 调用；process 由测试手动触发
 * （存储/消费/重试/停机语义属驱动职责，真实驱动由子包适配测试覆盖）
 */
function makeFakeDriver(options: { syncDispatch?: boolean } = {}) {
  const enqueues: EnqueueCall[] = [];
  const workers = new Map<string, { concurrency: number; process: TaskDriverProcess }>();
  const stopCalls: Array<number | undefined> = [];
  let startWorkerCalls = 0;
  let stopWorkersCalls = 0;
  let lastId = '';
  let seq = 0;

  const dispatch = async (name: string, payload: unknown, attempt = 1): Promise<unknown> => {
    const worker = workers.get(name);
    if (!worker) throw new Error(`no worker registered for "${name}"`);
    const job: TaskDriverJob = {
      id: lastId,
      name,
      payload,
      attempt,
      signal: new AbortController().signal,
    };
    return worker.process(job);
  };

  const driver: TaskDriver = {
    enqueue: async (name, payload, opts) => {
      lastId = `d-${++seq}`;
      enqueues.push({ name, payload, opts });
      if (options.syncDispatch) await dispatch(name, payload);
      return lastId;
    },
    startWorker: (name, opts) => {
      startWorkerCalls += 1;
      workers.set(name, opts);
    },
    stop: async (timeoutMs) => {
      stopCalls.push(timeoutMs);
    },
    stopWorkers: async () => {
      stopWorkersCalls += 1;
    },
  };

  return {
    driver,
    enqueues,
    workers,
    stopCalls,
    dispatch,
    counts: { startWorker: () => startWorkerCalls, stopWorkers: () => stopWorkersCalls },
  };
}

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

describe('createTaskQueue', () => {
  it('enqueue 校验后透传驱动（payload/retries/delayMs），返回驱动 id，记录 pending', async () => {
    const run = vi.fn(async () => 'ok');
    const zodLike = { safeParse: (v: unknown) => ({ success: true, data: v }) };
    const deps = makeDeps({ mail: { run } }, { mail: zodLike });
    const fake = makeFakeDriver();
    const queue = createTaskQueue({ ...deps, driver: fake.driver });
    queue.start();

    const { id } = await queue.enqueue('mail', { to: 'a@b.c' }, { delayMs: 500 });
    expect(id).toBe('d-1');
    expect(fake.enqueues[0]).toEqual({
      name: 'mail',
      payload: { to: 'a@b.c' },
      opts: { delayMs: 500, retries: 0 },
    });
    expect(queue.list('mail')[0]).toMatchObject({ id: 'd-1', status: 'pending' });
    await queue.stop();
  });

  it('入队时把任务 meta 的 retries 透传给驱动', async () => {
    const registry = createTaskRegistry();
    registry.hydrate([{ name: 'mail', filePath: 'dist/tasks/mail/task.js', retries: 3 }]);
    const fake = makeFakeDriver();
    const queue = createTaskQueue({
      registry,
      rootDir: '/fake',
      driver: fake.driver,
      loadTaskModule: async () => ({ run: vi.fn() }),
      loadPayloadSchema: async () => undefined,
    });
    queue.start();
    await queue.enqueue('mail', {});
    expect(fake.enqueues[0]?.opts?.retries).toBe(3);
    await queue.stop();
  });

  it('payload 校验失败抛 ValidationError 且不触达驱动', async () => {
    const zodLike = {
      safeParse: (_v: unknown) => ({
        success: false,
        error: { issues: [{ code: 'invalid_type', path: ['to'], message: 'Required' }] },
      }),
    };
    const deps = makeDeps({ mail: { run: vi.fn() } }, { mail: zodLike });
    const fake = makeFakeDriver();
    const queue = createTaskQueue({ ...deps, driver: fake.driver });
    queue.start();
    await expect(queue.enqueue('mail', { wrong: 1 })).rejects.toThrow(/validation/i);
    expect(fake.enqueues).toHaveLength(0);
    expect(queue.list('mail')).toHaveLength(0);
    await queue.stop();
  });

  it('无 Payload schema 跳过校验，原 payload 入队', async () => {
    const deps = makeDeps({ plain: { run: vi.fn() } });
    const fake = makeFakeDriver();
    const queue = createTaskQueue({ ...deps, driver: fake.driver });
    queue.start();
    await queue.enqueue('plain', { anything: true });
    expect(fake.enqueues[0]?.payload).toEqual({ anything: true });
    await queue.stop();
  });

  it('入队不存在的任务抛错（含可用任务名）且不触达驱动', async () => {
    const deps = makeDeps({ a: { run: vi.fn() } });
    const fake = makeFakeDriver();
    const queue = createTaskQueue({ ...deps, driver: fake.driver });
    queue.start();
    await expect(queue.enqueue('nope', {})).rejects.toThrow(/nope.*a/s);
    expect(fake.enqueues).toHaveLength(0);
    await queue.stop();
  });

  it('驱动派发 process：执行 run、注入 TaskContext、记录 attempts/done/result', async () => {
    const run = vi.fn(async (_payload: unknown, taskCtx: { job: { attempt: number } }) => ({
      echoed: taskCtx.job.attempt,
    }));
    const deps = makeDeps({ hello: { run } });
    const fake = makeFakeDriver();
    const queue = createTaskQueue({ ...deps, driver: fake.driver, config: { db: 1 } });
    queue.start();

    await queue.enqueue('hello', { a: 1 });
    await fake.dispatch('hello', { a: 1 }, 1);
    expect(run).toHaveBeenCalledTimes(1);
    const [payload, taskCtx] = run.mock.calls[0] as unknown as [
      unknown,
      { signal: AbortSignal; config: unknown; job: { id: string; name: string; attempt: number } },
    ];
    expect(payload).toEqual({ a: 1 });
    expect(taskCtx.config).toEqual({ db: 1 });
    expect(taskCtx.signal).toBeInstanceOf(AbortSignal);
    expect(taskCtx.job).toEqual({ id: 'd-1', name: 'hello', attempt: 1 });

    const job = queue.list('hello')[0]!;
    expect(job.status).toBe('done');
    expect(job.result).toEqual({ echoed: 1 });
    expect(job.attempts).toBe(1);
    await queue.stop();
  });

  it('process 抛错记录 failed 并向上传播；驱动再次派发时 attempts 递增', async () => {
    let calls = 0;
    const run = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('boom');
      return 'finally';
    });
    const deps = makeDeps({ flaky: { run } });
    const fake = makeFakeDriver();
    const queue = createTaskQueue({ ...deps, driver: fake.driver });
    queue.start();

    await queue.enqueue('flaky', {});
    await expect(fake.dispatch('flaky', {}, 1)).rejects.toThrow('boom');
    expect(queue.list('flaky')[0]).toMatchObject({ status: 'failed', attempts: 1, error: 'boom' });

    // 驱动决定重试：再次派发（attempt 2）→ 记录回到 done
    await fake.dispatch('flaky', {}, 2);
    const job = queue.list('flaky')[0]!;
    expect(job.status).toBe('done');
    expect(job.attempts).toBe(2);
    expect(job.result).toBe('finally');
    await queue.stop();
  });

  it('任务模块缺失 run：process 抛错记 failed，不崩溃', async () => {
    const deps = makeDeps({ empty: {} });
    const fake = makeFakeDriver();
    const queue = createTaskQueue({ ...deps, driver: fake.driver });
    queue.start();
    await queue.enqueue('empty');
    await expect(fake.dispatch('empty', {})).rejects.toThrow(/no run export/i);
    expect(queue.list('empty')[0]).toMatchObject({ status: 'failed' });
    await queue.stop();
  });

  it('start 为注册表每个任务注册 worker（concurrency 透传，默认 1），幂等', async () => {
    const deps = makeDeps({ a: { run: vi.fn() }, b: { run: vi.fn() } });
    const fake = makeFakeDriver();
    const registry = createTaskRegistry();
    registry.hydrate([
      { name: 'a', filePath: 'dist/tasks/a/task.js', concurrency: 4 },
      { name: 'b', filePath: 'dist/tasks/b/task.js' },
    ]);
    const queue = createTaskQueue({ ...deps, registry, driver: fake.driver });
    await queue.start();
    await queue.start();
    expect(fake.counts.startWorker()).toBe(2);
    expect(fake.workers.get('a')?.concurrency).toBe(4);
    expect(fake.workers.get('b')?.concurrency).toBe(1);
    await queue.stop();
  });

  it('stop 透传 timeoutMs 给驱动；停止后 enqueue/start 抛错', async () => {
    const deps = makeDeps({ a: { run: vi.fn() } });
    const fake = makeFakeDriver();
    const queue = createTaskQueue({ ...deps, driver: fake.driver });
    queue.start();
    await queue.stop(1234);
    expect(fake.stopCalls).toEqual([1234]);
    await expect(queue.enqueue('a', {})).rejects.toThrow(/stopped/i);
    await expect(queue.start()).rejects.toThrow(/stopped/i);
  });

  it('reload 调 driver.stopWorkers 后按最新注册表重注册 worker', async () => {
    const deps = makeDeps({ a: { run: vi.fn() } });
    const fake = makeFakeDriver();
    const queue = createTaskQueue({ ...deps, driver: fake.driver });
    await queue.start();
    await queue.reload();
    expect(fake.counts.stopWorkers()).toBe(1);
    expect(fake.counts.startWorker()).toBe(2); // start 一次 + reload 重注册一次
    expect(fake.workers.has('a')).toBe(true);
    await queue.stop();
  });

  it('invalidateModules 后 worker 派发重新加载任务模块', async () => {
    const run = vi.fn(async () => 'ok');
    const deps = makeDeps({ hello: { run } });
    const fake = makeFakeDriver();
    const queue = createTaskQueue({ ...deps, driver: fake.driver });
    queue.start();
    await queue.enqueue('hello');
    await fake.dispatch('hello', {});
    queue.invalidateModules();
    await fake.dispatch('hello', {}, 2);
    expect(deps.loadTaskModule).toHaveBeenCalledTimes(2);
    await queue.stop();
  });

  it('驱动 enqueue 同步派发时不覆盖已写入的执行记录', async () => {
    const deps = makeDeps({ hello: { run: async () => 'sync' } });
    const fake = makeFakeDriver({ syncDispatch: true });
    const queue = createTaskQueue({ ...deps, driver: fake.driver });
    queue.start();
    await queue.enqueue('hello', {});
    expect(queue.list('hello')[0]).toMatchObject({ status: 'done', result: 'sync' });
    await queue.stop();
  });

  it('list 不传 name 返回全部任务记录', async () => {
    const deps = makeDeps({
      a: { run: async () => 1 },
      b: { run: async () => 2 },
    });
    const fake = makeFakeDriver();
    const queue = createTaskQueue({ ...deps, driver: fake.driver });
    queue.start();
    await queue.enqueue('a');
    await queue.enqueue('b');
    expect(queue.list()).toHaveLength(2);
    await queue.stop();
  });
});
