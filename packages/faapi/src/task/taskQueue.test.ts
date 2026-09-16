import { describe, it, expect, vi } from 'vitest';
import { createTaskQueue } from './taskQueue';
import { createTaskRegistry } from './taskRegistry';
import { TaskCancelledError } from './taskWorker';
import { createAppRegistries, createTaskRegistriesView } from '../injection/registries';
import type { TaskDriver, TaskDriverJob, TaskDriverProcess } from './driverTypes';
import type { TaskContext, TaskModule } from './taskTypes';

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

  const dispatch = async (
    name: string,
    payload: unknown,
    attempt = 1,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    const worker = workers.get(name);
    if (!worker) throw new Error(`no worker registered for "${name}"`);
    const job: TaskDriverJob = {
      id: lastId,
      name,
      payload,
      attempt,
      signal: signal ?? new AbortController().signal,
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

  it('进程内执行注入 taskCtx.log：scope task:<name>，字段带 jobId/task/attempt，走全局管道', async () => {
    const { configureLogging } = await import('../logger/logger');
    const entries: Array<{
      level: string;
      message: string;
      scope?: string;
      fields?: Record<string, unknown>;
    }> = [];
    configureLogging({ sink: (e) => entries.push(e as never) });
    try {
      const run = vi.fn(
        async (
          _payload: unknown,
          taskCtx: {
            log?: {
              info: (m: string) => void;
              child: (s: string) => { debug: (m: string) => void };
            };
          },
        ) => {
          taskCtx.log!.info('settling');
          taskCtx.log!.child('db').debug('cache miss');
          return 'ok';
        },
      );
      const deps = makeDeps({ mailer: { run } });
      const fake = makeFakeDriver();
      const queue = createTaskQueue({ ...deps, driver: fake.driver });
      queue.start();
      await queue.enqueue('mailer', {});
      await fake.dispatch('mailer', {}, 1);
      expect(run).toHaveBeenCalledTimes(1);
      // 管道不配 level 时不过滤：info 与 child debug 全量进 sink
      expect(entries).toHaveLength(2);
      expect(entries[0].level).toBe('info');
      expect(entries[0].message).toBe('settling');
      expect(entries[0].scope).toBe('task:mailer');
      expect(entries[0].fields).toEqual({ jobId: 'd-1', task: 'mailer', attempt: 1 });
      expect(entries[1].level).toBe('debug');
      expect(entries[1].scope).toBe('task:mailer:db');
      await queue.stop();
    } finally {
      configureLogging(undefined);
    }
  });

  it('进程内 taskCtx.log 受管道阈值过滤（显式 level: info 时 debug 不输出）', async () => {
    const { configureLogging } = await import('../logger/logger');
    const entries: unknown[] = [];
    configureLogging({ level: 'info', sink: (e) => entries.push(e) });
    try {
      const run = vi.fn(
        async (
          _payload: unknown,
          taskCtx: { log?: { debug: (m: string) => void; info: (m: string) => void } },
        ) => {
          taskCtx.log!.debug('hidden');
          taskCtx.log!.info('shown');
        },
      );
      const deps = makeDeps({ mailer: { run } });
      const fake = makeFakeDriver();
      const queue = createTaskQueue({ ...deps, driver: fake.driver });
      queue.start();
      await queue.enqueue('mailer', {});
      await fake.dispatch('mailer', {}, 1);
      expect(entries).toHaveLength(1);
      expect((entries[0] as { message: string }).message).toBe('shown');
      await queue.stop();
    } finally {
      configureLogging(undefined);
    }
  });

  it('进程内 taskCtx.progress 记入记录（list 可见），派发清空上一轮，终态后调用被忽略', async () => {
    let lateProgress: ((value: unknown) => void) | undefined;
    let calls = 0;
    const run = vi.fn(async (_payload: unknown, taskCtx: TaskContext) => {
      calls += 1;
      if (calls === 1) {
        taskCtx.progress?.({ pct: 30 });
        taskCtx.progress?.({ pct: 60 });
        lateProgress = taskCtx.progress;
      }
      return 'ok';
    });
    const deps = makeDeps({ hello: { run } });
    const fake = makeFakeDriver();
    const queue = createTaskQueue({ ...deps, driver: fake.driver });
    queue.start();
    await queue.enqueue('hello');
    await fake.dispatch('hello', {});
    expect(queue.list('hello')[0]).toMatchObject({ status: 'done', progress: { pct: 60 } });
    // 终态后调用被忽略：不抛错、记录不变
    expect(() => lateProgress?.({ pct: 100 })).not.toThrow();
    expect(queue.list('hello')[0]?.progress).toEqual({ pct: 60 });
    // 重新派发清空上一轮 progress；本轮不调用则保持 undefined
    await queue.enqueue('hello');
    await fake.dispatch('hello', {}, 2);
    const second = queue.list('hello').find((j) => j.attempts === 2);
    expect(second).toMatchObject({ status: 'done' });
    expect(second?.progress).toBeUndefined();
    await queue.stop();
  });

  it('终态记录超上限（1000）按最旧优先淘汰，pending 记录永不淘汰', async () => {
    const run = vi.fn(async () => 'ok');
    const deps = makeDeps({ bulk: { run } });
    const fake = makeFakeDriver();
    const queue = createTaskQueue({ ...deps, driver: fake.driver });
    queue.start();
    const ids: string[] = [];
    for (let i = 0; i < 1002; i++) {
      const { id } = await queue.enqueue('bulk', { i });
      ids.push(id);
      await fake.dispatch('bulk', { i });
    }
    let list = queue.list('bulk');
    expect(list).toHaveLength(1000);
    expect(list.find((j) => j.id === ids[0])).toBeUndefined();
    expect(list.find((j) => j.id === ids[1])).toBeUndefined();
    expect(list.find((j) => j.id === ids[2])).toBeDefined();

    // pending 记录不受终态上限影响
    const pendingIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { id } = await queue.enqueue('bulk', { pending: i });
      pendingIds.push(id);
    }
    await queue.enqueue('bulk', { more: 1 });
    await fake.dispatch('bulk', { more: 1 });
    list = queue.list('bulk');
    expect(list.filter((j) => j.status === 'pending')).toHaveLength(3);
    for (const pid of pendingIds) {
      expect(list.find((j) => j.id === pid)).toBeDefined();
    }
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

  it('声明 timeoutMs 的任务走隔离执行器（runIsolated），进程内 run 不被调用', async () => {
    const run = vi.fn(async () => 'in-process');
    const fake = makeFakeDriver();
    const runIsolated = vi.fn(async (_opts: unknown) => 'from-worker');
    const registry = createTaskRegistry();
    registry.hydrate([{ name: 'heavy', filePath: 'dist/tasks/heavy/task.js', timeoutMs: 3000 }]);
    const queue = createTaskQueue({
      registry,
      rootDir: '/fake',
      driver: fake.driver,
      runIsolated: runIsolated as never,
      loadTaskModule: async () => ({ run }),
      loadPayloadSchema: async () => undefined,
    });
    queue.start();
    await queue.enqueue('heavy', { a: 1 });
    await fake.dispatch('heavy', { a: 1 }, 1);
    expect(runIsolated).toHaveBeenCalledTimes(1);
    const call = runIsolated.mock.calls[0]![0] as {
      taskModulePath: string;
      payload: unknown;
      timeoutMs: number;
      externalSignal: AbortSignal;
    };
    expect(call.taskModulePath).toContain('heavy');
    expect(call.timeoutMs).toBe(3000);
    expect(call.payload).toEqual({ a: 1 });
    expect(call.externalSignal).toBeInstanceOf(AbortSignal);
    expect(run).not.toHaveBeenCalled();
    expect(queue.list('heavy')[0]).toMatchObject({ status: 'done', result: 'from-worker' });
    await queue.stop();
  });

  it('隔离执行透传 meta.graceMs（宽限期），未声明时不传', async () => {
    const fake = makeFakeDriver();
    const runIsolated = vi.fn(async (_opts: unknown) => 'from-worker');
    const registry = createTaskRegistry();
    registry.hydrate([
      { name: 'heavy', filePath: 'dist/tasks/heavy/task.js', timeoutMs: 1000, graceMs: 8000 },
      { name: 'default', filePath: 'dist/tasks/default/task.js', timeoutMs: 1000 },
    ]);
    const queue = createTaskQueue({
      registry,
      rootDir: '/fake',
      driver: fake.driver,
      runIsolated: runIsolated as never,
      loadTaskModule: async () => ({}),
      loadPayloadSchema: async () => undefined,
    });
    queue.start();
    await queue.enqueue('heavy');
    await queue.enqueue('default');
    await fake.dispatch('heavy', {});
    await fake.dispatch('default', {});
    const opts = runIsolated.mock.calls.map((call) => call[0]) as Array<{
      taskModulePath: string;
      graceMs?: number;
    }>;
    expect(opts.find((o) => o.taskModulePath.includes('heavy'))?.graceMs).toBe(8000);
    expect(opts.find((o) => o.taskModulePath.includes('default'))?.graceMs).toBeUndefined();
    await queue.stop();
  });

  it('隔离执行抛错：记 failed 并向上传播（驱动重试语义不变）', async () => {
    const fake = makeFakeDriver();
    const runIsolated = vi.fn(async () => {
      throw new Error('worker terminated');
    });
    const registry = createTaskRegistry();
    registry.hydrate([{ name: 'heavy', filePath: 'dist/tasks/heavy/task.js', timeoutMs: 100 }]);
    const queue = createTaskQueue({
      registry,
      rootDir: '/fake',
      driver: fake.driver,
      runIsolated: runIsolated as never,
      loadTaskModule: async () => ({}),
      loadPayloadSchema: async () => undefined,
    });
    queue.start();
    await queue.enqueue('heavy');
    await expect(fake.dispatch('heavy', {}, 1)).rejects.toThrow('worker terminated');
    expect(queue.list('heavy')[0]).toMatchObject({ status: 'failed', error: 'worker terminated' });
    await queue.stop();
  });

  it('隔离执行抛 TaskCancelledError：记 cancelled（区别于 run 自身失败）', async () => {
    const fake = makeFakeDriver();
    const runIsolated = vi.fn(async () => {
      throw new TaskCancelledError('Task "heavy" timed out after 100ms and was terminated');
    });
    const registry = createTaskRegistry();
    registry.hydrate([{ name: 'heavy', filePath: 'dist/tasks/heavy/task.js', timeoutMs: 100 }]);
    const queue = createTaskQueue({
      registry,
      rootDir: '/fake',
      driver: fake.driver,
      runIsolated: runIsolated as never,
      loadTaskModule: async () => ({}),
      loadPayloadSchema: async () => undefined,
    });
    queue.start();
    await queue.enqueue('heavy');
    await expect(fake.dispatch('heavy', {}, 1)).rejects.toThrow(/timed out/);
    expect(queue.list('heavy')[0]).toMatchObject({
      status: 'cancelled',
      error: 'Task "heavy" timed out after 100ms and was terminated',
    });
    await queue.stop();
  });

  it('停机取消：job.signal 已 abort 时执行终止记 cancelled（进程内路径）', async () => {
    const run = vi.fn(async () => {
      throw new Error('aborted mid-run');
    });
    const deps = makeDeps({ light: { run } });
    const fake = makeFakeDriver();
    const queue = createTaskQueue({ ...deps, driver: fake.driver });
    queue.start();
    await queue.enqueue('light');
    const controller = new AbortController();
    controller.abort(); // 停机超时后驱动 abort（任务收到 signal 退出）
    await expect(fake.dispatch('light', {}, 1, controller.signal)).rejects.toThrow('aborted');
    expect(queue.list('light')[0]).toMatchObject({ status: 'cancelled' });
    await queue.stop();
  });

  it('signal 已 abort 但 run 正常完成：仍记 done（取消不覆盖成功执行）', async () => {
    const run = vi.fn(async () => 'finished anyway');
    const deps = makeDeps({ light: { run } });
    const fake = makeFakeDriver();
    const queue = createTaskQueue({ ...deps, driver: fake.driver });
    queue.start();
    await queue.enqueue('light');
    const controller = new AbortController();
    controller.abort();
    await fake.dispatch('light', {}, 1, controller.signal);
    expect(queue.list('light')[0]).toMatchObject({ status: 'done', result: 'finished anyway' });
    await queue.stop();
  });

  it('未声明 timeoutMs 的任务走进程内路径，不触达 runIsolated', async () => {
    const run = vi.fn(async () => 'in-process');
    const fake = makeFakeDriver();
    const runIsolated = vi.fn(async () => 'from-worker');
    const deps = makeDeps({ light: { run } });
    const queue = createTaskQueue({
      ...deps,
      driver: fake.driver,
      runIsolated: runIsolated as never,
    });
    queue.start();
    await queue.enqueue('light');
    await fake.dispatch('light', {}, 1);
    expect(runIsolated).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(1);
    expect(queue.list('light')[0]).toMatchObject({ status: 'done', result: 'in-process' });
    await queue.stop();
  });

  it('listQueued：驱动持久化记录转换为本进程快照形状，并按 id 与本进程记录合并（本地优先）', async () => {
    const deps = makeDeps({ a: { run: async () => 'local-result' } });
    const fake = makeFakeDriver();
    const queue = createTaskQueue({
      ...deps,
      driver: {
        ...fake.driver,
        list: async () => [
          {
            id: 'ext-1',
            name: 'a',
            payload: { from: 'driver' },
            status: 'done' as const,
            attempts: 1,
            result: 'driver-result',
            createdAt: 111,
          },
          {
            id: 'ext-2',
            name: 'a',
            payload: {},
            status: 'failed' as const,
            attempts: 2,
            error: 'driver error',
            createdAt: 222,
          },
        ],
      },
    });
    queue.start();
    await queue.enqueue('a');
    await fake.dispatch('a', {}, 1); // 本进程记录 d-1 → done

    const queued = await queue.listQueued('a');
    // 本进程记录覆盖驱动侧同 id 记录（attempts/result 以本地为准）
    const local = queued.find((j) => j.id === 'd-1')!;
    expect(local.status).toBe('done');
    expect(local.result).toBe('local-result');
    // 驱动侧独有记录原样转换
    const ext = queued.find((j) => j.id === 'ext-1')!;
    expect(ext).toMatchObject({ status: 'done', result: 'driver-result', createdAt: 111 });
    expect(queued.find((j) => j.id === 'ext-2')).toMatchObject({
      status: 'failed',
      error: 'driver error',
    });
    // name 过滤生效（三条都是 a——用不存在过滤验证）
    expect(await queue.listQueued('nonexistent')).toHaveLength(0);
    await queue.stop();
  });

  it('listQueued：驱动未实现 list 时显式抛错（不静默回退快照）', async () => {
    const deps = makeDeps({ a: { run: async () => 1 } });
    const fake = makeFakeDriver();
    const queue = createTaskQueue({ ...deps, driver: fake.driver });
    queue.start();
    await expect(queue.listQueued()).rejects.toThrow(/does not support/);
    await queue.stop();
  });

  it('cancel：透传驱动并更新本进程记录为 cancelled', async () => {
    const deps = makeDeps({ a: { run: async () => 1 } });
    const cancelCalls: Array<{ name: string; id: string }> = [];
    const fake = makeFakeDriver();
    const queue = createTaskQueue({
      ...deps,
      driver: {
        ...fake.driver,
        cancel: async (name, id) => {
          cancelCalls.push({ name, id });
        },
      },
    });
    queue.start();
    const { id } = await queue.enqueue('a');
    await queue.cancel('a', id);
    expect(cancelCalls).toEqual([{ name: 'a', id }]);
    expect(queue.list('a')[0]).toMatchObject({ status: 'cancelled' });
    await queue.stop();
  });

  it('retry：透传驱动并把本进程记录回 pending 等待重新派发', async () => {
    const deps = makeDeps({ a: { run: async () => 1 } });
    const retryCalls: Array<{ name: string; id: string }> = [];
    const fake = makeFakeDriver();
    const queue = createTaskQueue({
      ...deps,
      driver: {
        ...fake.driver,
        retry: async (name, id) => {
          retryCalls.push({ name, id });
        },
      },
    });
    queue.start();
    const { id } = await queue.enqueue('a');
    await fake.dispatch('a', {}, 1); // 制造一条本进程记录（done）
    expect(queue.list('a')[0]?.status).toBe('done');
    await queue.retry('a', id);
    expect(retryCalls).toEqual([{ name: 'a', id }]);
    expect(queue.list('a')[0]).toMatchObject({ status: 'pending' });
    await queue.stop();
  });

  it('cancel/retry：驱动未实现时显式抛错', async () => {
    const deps = makeDeps({ a: { run: async () => 1 } });
    const fake = makeFakeDriver();
    const queue = createTaskQueue({ ...deps, driver: fake.driver });
    queue.start();
    await expect(queue.cancel('a', 'x')).rejects.toThrow(/does not support/);
    await expect(queue.retry('a', 'x')).rejects.toThrow(/does not support/);
    await queue.stop();
  });

  it('enqueue 透传 dedupId 幂等键给驱动', async () => {
    const deps = makeDeps({ a: { run: async () => 1 } });
    const fake = makeFakeDriver();
    const queue = createTaskQueue({ ...deps, driver: fake.driver });
    queue.start();
    await queue.enqueue('a', {}, { dedupId: 'order-confirm:1' });
    expect(fake.enqueues[0]?.opts).toMatchObject({ dedupId: 'order-confirm:1', retries: 0 });
    await queue.stop();
  });

  it('onFailed：执行失败后触发，willRetry 按 meta.retries 推算', async () => {
    const registry = createTaskRegistry();
    registry.hydrate([{ name: 'flaky', filePath: 'd.js', retries: 2 }]);
    const onFailed = vi.fn(async () => {});
    const fake = makeFakeDriver();
    const queue = createTaskQueue({
      registry,
      rootDir: '/fake',
      driver: fake.driver,
      onFailed,
      loadTaskModule: async () => ({
        run: async () => {
          throw new Error('boom');
        },
      }),
      loadPayloadSchema: async () => undefined,
    });
    queue.start();
    const { id } = await queue.enqueue('flaky');
    await expect(fake.dispatch('flaky', {}, 1)).rejects.toThrow('boom');
    expect(onFailed).toHaveBeenCalledWith({
      task: 'flaky',
      jobId: id,
      attempt: 1,
      willRetry: true,
      cancelled: false,
      error: 'boom',
    });
    await queue.stop();
  });

  it('onFailed：取消路径触发且 cancelled 为 true；自身抛错被忽略', async () => {
    const registry = createTaskRegistry();
    registry.hydrate([{ name: 'heavy', filePath: 'd.js', timeoutMs: 100 }]);
    const onFailed = vi.fn(async (_info: unknown) => {
      throw new Error('hook blew up');
    });
    const fake = makeFakeDriver();
    const runIsolated = vi.fn(async () => {
      throw new TaskCancelledError('Task "heavy" timed out after 100ms and was terminated');
    });
    const queue = createTaskQueue({
      registry,
      rootDir: '/fake',
      driver: fake.driver,
      onFailed,
      runIsolated: runIsolated as never,
      loadTaskModule: async () => ({}),
      loadPayloadSchema: async () => undefined,
    });
    queue.start();
    await queue.enqueue('heavy');
    await expect(fake.dispatch('heavy', {}, 1)).rejects.toThrow(/timed out/);
    expect(onFailed).toHaveBeenCalledTimes(1);
    expect(onFailed.mock.calls[0]![0]).toMatchObject({
      task: 'heavy',
      attempt: 1,
      willRetry: false,
      cancelled: true,
    });
    // 记录已写入，钩子抛错不影响队列
    expect(queue.list('heavy')[0]).toMatchObject({ status: 'cancelled' });
    await queue.stop();
  });

  it('进程内执行注入注册表只读视图：run 的 taskCtx.registries 可查已水合元数据', async () => {
    const appRegistries = createAppRegistries();
    appRegistries.agent.hydrate([
      { name: 'log-analyzer', filePath: 'dist/agents/log-analyzer/handler.js', hasRun: false },
    ]);
    appRegistries.tool.hydrate([
      { name: 'parse', functionName: 'parse', filePath: 'dist/tools/parse/handler.ts' },
    ]);
    appRegistries.skill.hydrate([{ name: 'db-skill', systemPrompt: 's' }]);

    const run = vi.fn(async (_payload: unknown, taskCtx: unknown) => taskCtx);
    const deps = makeDeps({ hello: { run } });
    const fake = makeFakeDriver();
    const queue = createTaskQueue({
      ...deps,
      driver: fake.driver,
      registries: createTaskRegistriesView(appRegistries),
    });
    queue.start();

    await queue.enqueue('hello');
    await fake.dispatch('hello', {}, 1);
    const [, taskCtx] = run.mock.calls[0] as unknown as [
      unknown,
      {
        registries: {
          agent: { getAgent: (n: string) => unknown; listAgents: () => unknown[] };
          tool: { get: (n: string) => unknown };
          skill: { get: (n: string) => unknown };
        };
      },
    ];
    expect(taskCtx.registries.agent.getAgent('log-analyzer')).toMatchObject({
      name: 'log-analyzer',
    });
    expect(taskCtx.registries.agent.listAgents()).toHaveLength(1);
    expect(taskCtx.registries.tool.get('parse')).toMatchObject({ name: 'parse' });
    expect(taskCtx.registries.skill.get('db-skill')).toMatchObject({ name: 'db-skill' });
    await queue.stop();
  });

  it('隔离执行传注册表纯数据快照：runIsolated 收到 agents（完整元数据）/tools/skills', async () => {
    const appRegistries = createAppRegistries();
    appRegistries.agent.hydrate([
      {
        name: 'log-analyzer',
        description: 'analyzer',
        filePath: 'dist/agents/log-analyzer/handler.js',
        hasRun: false,
        systemPrompt: 'p',
      },
    ]);
    appRegistries.tool.hydrate([
      { name: 'parse', functionName: 'parse', filePath: 'dist/tools/parse/handler.ts' },
    ]);
    appRegistries.skill.hydrate([{ name: 'db-skill', systemPrompt: 's' }]);

    const fake = makeFakeDriver();
    const runIsolated = vi.fn(async (_opts: unknown) => 'from-worker');
    const registry = createTaskRegistry();
    registry.hydrate([{ name: 'heavy', filePath: 'dist/tasks/heavy/task.js', timeoutMs: 3000 }]);
    const queue = createTaskQueue({
      registry,
      rootDir: '/fake',
      driver: fake.driver,
      registries: createTaskRegistriesView(appRegistries),
      runIsolated: runIsolated as never,
      loadTaskModule: async () => ({}),
      loadPayloadSchema: async () => undefined,
    });
    queue.start();
    await queue.enqueue('heavy');
    await fake.dispatch('heavy', {}, 1);

    const call = runIsolated.mock.calls[0]![0] as {
      registries: {
        agents: Array<{ name: string; filePath?: string; hasRun?: boolean; systemPrompt?: string }>;
        tools: Array<{ name: string }>;
        skills: Array<{ name: string }>;
      };
    };
    // agents 为完整元数据快照（含 filePath/hasRun，非仅 LLM 可见字段）
    expect(call.registries.agents).toEqual([
      {
        name: 'log-analyzer',
        description: 'analyzer',
        filePath: 'dist/agents/log-analyzer/handler.js',
        hasRun: false,
        systemPrompt: 'p',
      },
    ]);
    expect(call.registries.tools).toEqual([
      { name: 'parse', functionName: 'parse', filePath: 'dist/tools/parse/handler.ts' },
    ]);
    expect(call.registries.skills).toEqual([{ name: 'db-skill', systemPrompt: 's' }]);
    await queue.stop();
  });

  it('未传 registries 的 deps：两条路径均以空视图兜底（直接构造队列的测试场景不破坏）', async () => {
    const run = vi.fn(async (_payload: unknown, taskCtx: unknown) => {
      const r = (taskCtx as { registries: { agent: { listAgents: () => unknown[] } } }).registries;
      return { agentCount: r.agent.listAgents().length };
    });
    const fake = makeFakeDriver();
    const runIsolated = vi.fn(async (opts: { registries: unknown }) => opts.registries);
    const registry = createTaskRegistry();
    registry.hydrate([
      { name: 'hello', filePath: 'dist/tasks/hello/task.js' },
      { name: 'heavy', filePath: 'dist/tasks/heavy/task.js', timeoutMs: 100 },
    ]);
    const queue = createTaskQueue({
      registry,
      rootDir: '/fake',
      driver: fake.driver,
      runIsolated: runIsolated as never,
      loadTaskModule: async () => ({ run }),
      loadPayloadSchema: async () => undefined,
    });
    queue.start();

    await queue.enqueue('hello');
    await fake.dispatch('hello', {}, 1);
    // 空视图：查询可用且返回空（任务调用 listAgents() 得 0）
    expect(run).toHaveResolvedWith({ agentCount: 0 });

    await queue.enqueue('heavy');
    await fake.dispatch('heavy', {}, 1);
    expect(runIsolated.mock.calls[0]![0]).toMatchObject({
      registries: { agents: [], tools: [], skills: [] },
    });
    await queue.stop();
  });
});
