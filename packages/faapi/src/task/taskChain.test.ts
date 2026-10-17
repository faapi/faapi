import { describe, it, expect, vi } from 'vitest';
import { createTaskQueue } from './taskQueue';
import { createTaskRegistry } from './taskRegistry';
import type { TaskWorkerRunner } from './taskWorker';
import type { TaskDriver, TaskDriverJob, TaskDriverProcess, TaskDriverRecord } from './driverTypes';
import type { TaskClient, TaskJobStatus, TaskModule } from './taskTypes';

/**
 * 链式任务语义层测试：enqueueChain 键控单飞（活跃查证 / dedupId 托管 / 排除自身 /
 * 能力边界）。chainKey 载荷包装与记录还原由驱动子包适配测试覆盖，此处用内存版
 * fake driver 固定 TaskDriver.list 查证通道契约。
 */

interface EnqueueCall {
  name: string;
  payload: unknown;
  opts?: {
    delayMs?: number;
    retries?: number;
    dedupId?: string;
    groupId?: string;
    chainKey?: string;
    excludeJobId?: string;
  };
}

/** 带队列侧记录（活跃查证数据源）的可编程 fake driver */
function makeFakeChainDriver() {
  const enqueues: EnqueueCall[] = [];
  const workers = new Map<string, { concurrency: number; process: TaskDriverProcess }>();
  const dedupIds = new Map<string, string>();
  let seq = 0;
  /** 查证快照（静态注入）；getter 形态供"自身 id 运行时才知道"的场景使用 */
  let queued: TaskDriverRecord[] = [];
  let queuedFn: (() => TaskDriverRecord[]) | undefined;

  const driver: TaskDriver = {
    enqueue: async (name, payload, opts) => {
      const key = opts?.dedupId ? `dedup:${opts.dedupId}` : `seq:${++seq}`;
      const existing = opts?.dedupId ? dedupIds.get(key) : undefined;
      if (existing) return existing;
      const id = `d-${++seq}`;
      if (opts?.dedupId) dedupIds.set(key, id);
      enqueues.push({ name, payload, opts });
      return id;
    },
    startWorker: (name, opts) => {
      workers.set(name, opts);
    },
    stop: async () => {},
    cancel: async () => {},
    retry: async () => {},
    list: async (opts) =>
      (queuedFn ? queuedFn() : queued)
        .filter((r) => opts?.name === undefined || r.name === opts.name)
        .slice(0, opts?.limit ?? 50),
  };

  return {
    driver,
    enqueues,
    workers,
    setQueued(records: TaskDriverRecord[]) {
      queued = records;
      queuedFn = undefined;
    },
    setQueuedFn(fn: () => TaskDriverRecord[]) {
      queuedFn = fn;
    },
  };
}

/** 队列侧记录构造 helper */
function rec(name: string, id: string, status: TaskJobStatus, chainKey?: string): TaskDriverRecord {
  return {
    id,
    name,
    payload: {},
    status,
    attempts: 1,
    createdAt: Date.now(),
    ...(chainKey !== undefined ? { chainKey } : {}),
  };
}

/** 恒通过的透传 schema（z.unknown() 产物形态） */
const PASS_THROUGH_SCHEMA = { safeParse: (v: unknown) => ({ success: true, data: v }) };

function makeDeps(modules: Record<string, TaskModule>) {
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
  const loadPayloadSchema = vi.fn(async () => PASS_THROUGH_SCHEMA);
  return { registry, rootDir: '/fake', config: {}, loadTaskModule, loadPayloadSchema };
}

describe('enqueueChain（链式任务）', () => {
  it('无活跃：入队返回 enqueued=true，chainKey 透传驱动 + dedupId 托管 + 本地记录带 chainKey', async () => {
    const deps = makeDeps({ chains: { run: vi.fn() } });
    const fake = makeFakeChainDriver();
    const queue = createTaskQueue({ ...deps, driver: fake.driver });
    queue.start();

    const res = await queue.enqueueChain('chains', { seg: 1 }, { chainKey: 'c:1' });
    expect(res).toEqual({ enqueued: true, id: expect.any(String) });
    expect(fake.enqueues).toHaveLength(1);
    expect(fake.enqueues[0]!.opts?.chainKey).toBe('c:1');
    expect(fake.enqueues[0]!.opts?.dedupId).toMatch(/^faapi-chain:c:1:\d+$/);
    expect(queue.list('chains')[0]?.chainKey).toBe('c:1');
    await queue.stop();
  });

  it('活跃同键命中：不投递，返回活跃任务现状', async () => {
    const deps = makeDeps({ chains: { run: vi.fn() } });
    const fake = makeFakeChainDriver();
    fake.setQueued([rec('chains', 'd-active', 'running', 'c:1')]);
    const queue = createTaskQueue({ ...deps, driver: fake.driver });
    queue.start();

    const res = await queue.enqueueChain('chains', { seg: 2 }, { chainKey: 'c:1' });
    expect(res).toEqual({ enqueued: false, jobId: 'd-active', status: 'running' });
    expect(fake.enqueues).toHaveLength(0);
    await queue.stop();
  });

  it('同键终态（done/failed/cancelled）不挡投递', async () => {
    const deps = makeDeps({ chains: { run: vi.fn() } });
    const fake = makeFakeChainDriver();
    fake.setQueued([
      rec('chains', 'd-done', 'done', 'c:1'),
      rec('chains', 'd-failed', 'failed', 'c:1'),
      rec('chains', 'd-cancelled', 'cancelled', 'c:1'),
    ]);
    const queue = createTaskQueue({ ...deps, driver: fake.driver });
    queue.start();

    const res = await queue.enqueueChain('chains', { seg: 2 }, { chainKey: 'c:1' });
    expect(res).toEqual({ enqueued: true, id: expect.any(String) });
    await queue.stop();
  });

  it('异键活跃不挡投递', async () => {
    const deps = makeDeps({ chains: { run: vi.fn() } });
    const fake = makeFakeChainDriver();
    fake.setQueued([rec('chains', 'd-other', 'running', 'c:2')]);
    const queue = createTaskQueue({ ...deps, driver: fake.driver });
    queue.start();

    const res = await queue.enqueueChain('chains', { seg: 1 }, { chainKey: 'c:1' });
    expect(res).toEqual({ enqueued: true, id: expect.any(String) });
    await queue.stop();
  });

  it('显式 excludeJobId：命中记录被排除', async () => {
    const deps = makeDeps({ chains: { run: vi.fn() } });
    const fake = makeFakeChainDriver();
    fake.setQueued([rec('chains', 'd-self', 'running', 'c:1')]);
    const queue = createTaskQueue({ ...deps, driver: fake.driver });
    queue.start();

    const res = await queue.enqueueChain(
      'chains',
      { seg: 2 },
      {
        chainKey: 'c:1',
        excludeJobId: 'd-self',
      },
    );
    expect(res).toEqual({ enqueued: true, id: expect.any(String) });
    await queue.stop();
  });

  it('dedupId 托管：终态后重投时间戳后缀不同（不被保留期固定键占坑）', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const deps = makeDeps({ chains: { run: vi.fn() } });
      const fake = makeFakeChainDriver();
      const queue = createTaskQueue({ ...deps, driver: fake.driver });
      queue.start();

      const first = await queue.enqueueChain('chains', { seg: 1 }, { chainKey: 'c:1' });
      // 首条执行完毕置终态（驱动侧记录 + 本进程记录跑完转 done，双口径一致）
      if (!first.enqueued) throw new Error('expected first enqueue to succeed');
      await fake.workers.get('chains')!.process({
        id: first.id,
        name: 'chains',
        payload: { seg: 1 },
        attempt: 1,
        signal: new AbortController().signal,
      });
      fake.setQueued([rec('chains', first.id, 'done', 'c:1')]);
      vi.setSystemTime(new Date('2026-01-01T00:00:01Z'));
      await queue.enqueueChain('chains', { seg: 2 }, { chainKey: 'c:1' });

      const dedupIds = fake.enqueues.map((e) => e.opts?.dedupId);
      expect(dedupIds).toHaveLength(2);
      expect(dedupIds[0]).toMatch(/^faapi-chain:c:1:\d+$/);
      expect(dedupIds[1]).toMatch(/^faapi-chain:c:1:\d+$/);
      expect(dedupIds[0]).not.toBe(dedupIds[1]);
      await queue.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('chainKey 缺失 / 空白抛错', async () => {
    const deps = makeDeps({ chains: { run: vi.fn() } });
    const fake = makeFakeChainDriver();
    const queue = createTaskQueue({ ...deps, driver: fake.driver });
    queue.start();

    await expect(queue.enqueueChain('chains', {}, optsUndefined())).rejects.toThrow('chainKey');
    await expect(queue.enqueueChain('chains', {}, { chainKey: '   ' })).rejects.toThrow('chainKey');
    await queue.stop();
  });

  it('驱动未实现 list：显式抛错（能力边界，与 listQueued 同口径）', async () => {
    const deps = makeDeps({ chains: { run: vi.fn() } });
    const driver: TaskDriver = {
      enqueue: async () => 'd-1',
      startWorker: () => {},
      stop: async () => {},
    };
    const queue = createTaskQueue({ ...deps, driver });
    queue.start();

    await expect(queue.enqueueChain('chains', {}, { chainKey: 'c:1' })).rejects.toThrow(
      /TaskDriver\.list/,
    );
    await queue.stop();
  });

  it('payload 校验失败抛 ValidationError；未知任务名抛错；队列停止后抛错', async () => {
    const deps = makeDeps({ chains: { run: vi.fn() } });
    const fake = makeFakeChainDriver();
    const badSchema = createTaskQueue({
      ...deps,
      loadPayloadSchema: vi.fn(async () => ({
        safeParse: (_v: unknown) => ({ success: false, error: 'bad payload' }),
      })),
      driver: fake.driver,
    });
    badSchema.start();
    await expect(badSchema.enqueueChain('chains', {}, { chainKey: 'c:1' })).rejects.toThrow(
      'validation',
    );
    await badSchema.stop();

    const queue = createTaskQueue({ ...deps, driver: fake.driver });
    queue.start();
    await expect(queue.enqueueChain('nope', {}, { chainKey: 'c:1' })).rejects.toThrow(
      'Unknown task',
    );
    await queue.stop();
    await expect(queue.enqueueChain('chains', {}, { chainKey: 'c:1' })).rejects.toThrow('stopped');
  });

  it('listQueued 合并视图带 chainKey（驱动记录还原路径）', async () => {
    const deps = makeDeps({ chains: { run: vi.fn() } });
    const fake = makeFakeChainDriver();
    fake.setQueued([rec('chains', 'd-driver', 'running', 'c:1')]);
    const queue = createTaskQueue({ ...deps, driver: fake.driver });
    queue.start();

    const queued = await queue.listQueued('chains');
    const driverSide = queued.find((j) => j.id === 'd-driver');
    expect(driverSide?.chainKey).toBe('c:1');
    await queue.stop();
  });
});

describe('taskCtx.tasks 排除自身（进程内）', () => {
  it('任务内自续投：自身 running 同键被自动排除，照常入队', async () => {
    let chainResult: unknown;
    let selfId = '';
    const deps = makeDeps({
      chains: {
        run: vi.fn(
          async (_payload: unknown, taskCtx: { job: { id: string }; tasks: TaskClient }) => {
            selfId = taskCtx.job.id;
            chainResult = await taskCtx.tasks.enqueueChain(
              'chains',
              { seg: 2 },
              {
                chainKey: 'c:1',
              },
            );
            return 'ok';
          },
        ),
      },
    });
    const fake = makeFakeChainDriver();
    // 查证快照 getter：求值时 run 已启动、selfId 已知（自身 running 同键）
    fake.setQueuedFn(() => [rec('chains', selfId || 'SELF', 'running', 'c:1')]);
    const queue = createTaskQueue({ ...deps, driver: fake.driver });
    queue.start();

    const worker = fake.workers.get('chains')!;
    await worker.process({
      id: 'unknown-until-run',
      name: 'chains',
      payload: {},
      attempt: 1,
      signal: new AbortController().signal,
    } as TaskDriverJob);
    expect(chainResult).toEqual({ enqueued: true, id: expect.any(String) });
    await queue.stop();
  });

  it('同键其他任务活跃（非自身）照常挡投递', async () => {
    let chainResult: unknown;
    const deps = makeDeps({
      chains: {
        run: vi.fn(async (_payload: unknown, taskCtx: { tasks: TaskClient }) => {
          chainResult = await taskCtx.tasks.enqueueChain(
            'chains',
            { seg: 2 },
            {
              chainKey: 'c:1',
            },
          );
          return 'ok';
        }),
      },
    });
    const fake = makeFakeChainDriver();
    fake.setQueuedFn(() => [rec('chains', 'd-fork', 'running', 'c:1')]);
    const queue = createTaskQueue({ ...deps, driver: fake.driver });
    queue.start();

    const worker = fake.workers.get('chains')!;
    await worker.process({
      id: 'd-self',
      name: 'chains',
      payload: {},
      attempt: 1,
      signal: new AbortController().signal,
    });
    expect(chainResult).toEqual({ enqueued: false, jobId: 'd-fork', status: 'running' });
    expect(fake.enqueues).toHaveLength(0);
    await queue.stop();
  });
});

describe('taskCtx.tasks 排除自身（隔离路径宿主注入）', () => {
  it('onTasksCall 分派 enqueueChain 时注入 excludeJobId = 隔离 job id；白名单放行', async () => {
    let captured: Parameters<TaskWorkerRunner>[0] | undefined;
    const deps = makeDeps({ chains: { run: vi.fn() } });
    deps.registry.hydrate([
      { name: 'chains', filePath: 'dist/tasks/chains/task.js', timeoutMs: 60000 },
    ]);
    const runIsolated = vi.fn(async (opts: Parameters<TaskWorkerRunner>[0]) => {
      captured = opts;
      return 'ok';
    });
    const fake = makeFakeChainDriver();
    // 查证快照：隔离任务自身（iso-1）running 同键——未注入 excludeJobId 会被挡，
    // 注入后自身被排除照常入队（行为断言注入生效）
    fake.setQueued([rec('chains', 'iso-1', 'running', 'c:1')]);
    const queue = createTaskQueue({ ...deps, driver: fake.driver, runIsolated });
    queue.start();

    const worker = fake.workers.get('chains')!;
    await worker.process({
      id: 'iso-1',
      name: 'chains',
      payload: {},
      attempt: 1,
      signal: new AbortController().signal,
    });
    expect(captured?.onTasksCall).toBeDefined();

    // 白名单放行 + 宿主注入自身 job id → 自身被排除，续投入队
    const injected = (await captured!.onTasksCall!('enqueueChain', [
      'chains',
      { seg: 2 },
      { chainKey: 'c:1' },
    ])) as { enqueued: boolean };
    expect(injected).toEqual({ enqueued: true, id: expect.any(String) });
    expect(fake.enqueues.at(-1)!.opts?.chainKey).toBe('c:1');

    // 白名单外方法仍拒绝
    await expect(captured!.onTasksCall!('steal', [])).rejects.toThrow('Unknown task client method');
    await queue.stop();
  });
});

/** 模拟 opts 未传 chainKey 的调用（类型面 chainKey 必填，运行时守卫验证） */
function optsUndefined(): undefined {
  return undefined;
}
