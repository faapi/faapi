import path from 'node:path';
import { ValidationError } from '../errors/httpErrors';
import { runTaskInWorker, TaskCancelledError } from './taskWorker';
import type { TaskDriverJob } from './driverTypes';
import type { TaskContext, TaskJob, TaskModule, TaskQueue, TaskQueueDeps } from './taskTypes';

/**
 * 任务队列语义层
 *
 * 职责边界（driverTypes.md）：
 * - 本层：任务存在性检查 → payload zod 校验 → 驱动入队；worker 执行包装
 *   （模块加载 + run 调用 + 任务记录更新）；start/stop/reload 生命周期编排
 * - 驱动层（deps.driver，必填——持久化驱动子包或自定义 TaskDriver）：
 *   入队存储、worker 消费、重试策略、停机 drain
 *
 * 任务记录（list）由本层维护：enqueue 写 pending，每次 process 写 attempts/running，
 * 返回写 done，抛错写 failed——对任何驱动语义一致。
 */
export function createTaskQueue(deps: TaskQueueDeps): TaskQueue {
  const { registry, rootDir, driver } = deps;

  /** 任务记录（id → job；跨驱动一致的本地快照） */
  const records = new Map<string, TaskJob>();
  /** 任务模块缓存（name → module） */
  const moduleCache = new Map<string, TaskModule>();
  /** payload schema 缓存（name → schema 或 undefined 表示无 schema） */
  const schemaCache = new Map<string, unknown>();

  let started = false;
  let stopped = false;

  const loadTaskModule =
    deps.loadTaskModule ?? (async (filePath: string) => (await import(filePath)) as TaskModule);

  const loadPayloadSchema =
    deps.loadPayloadSchema ??
    (async (filePath: string) => {
      const zodPath = path.join(path.dirname(filePath), 'zod.js');
      try {
        const mod = (await import(zodPath)) as Record<string, unknown>;
        const schemaKey = Object.keys(mod).find((k) => k.endsWith('Schema'));
        return schemaKey ? mod[schemaKey] : undefined;
      } catch {
        // 无 zod.js（任务未声明 Payload 类型）→ 无校验，与 tool 行为对齐（fallback.md）
        return undefined;
      }
    });

  function assertKnownTask(name: string): void {
    const meta = registry.get(name);
    if (!meta) {
      const known =
        registry
          .list()
          .map((t) => t.name)
          .join(', ') || '(none)';
      throw new Error(`[faapi] Unknown task "${name}". Registered tasks: ${known}`);
    }
  }

  async function validatePayload(name: string, payload: unknown): Promise<unknown> {
    if (!schemaCache.has(name)) {
      const meta = registry.get(name)!;
      schemaCache.set(
        name,
        await loadPayloadSchema(path.resolve(rootDir, meta.filePath)).catch(() => undefined),
      );
    }
    const schema = schemaCache.get(name);
    if (!schema || typeof (schema as { safeParse?: unknown }).safeParse !== 'function') {
      return payload;
    }
    const result = (
      schema as {
        safeParse: (v: unknown) => { success: boolean; data?: unknown; error?: unknown };
      }
    ).safeParse(payload);
    if (!result.success) {
      throw new ValidationError(
        `Task payload validation failed for "${name}": ${JSON.stringify(result.error)}`,
        [],
      );
    }
    return result.data;
  }

  /**
   * worker 执行函数（交给驱动调用的 process）：模块加载 + run 调用 + 任务记录更新
   *
   * 按 meta.timeoutMs 分两条执行路径：
   * - 声明 timeoutMs → 隔离执行器（独立 worker 线程，超时两段式取消真终止，见 taskWorker.md）
   * - 未声明 → 进程内执行（零开销；卡住时框架只能不再等待）
   *
   * 抛错 = 本次失败，由驱动按 retries 决定重试；重试再次进入本函数（attempt 递增）。
   */
  async function runJob(job: TaskDriverJob): Promise<unknown> {
    const meta = registry.get(job.name);
    if (!meta) throw new Error(`[faapi] Unknown task "${job.name}" at worker dispatch`);

    const record: TaskJob = records.get(job.id) ?? {
      id: job.id,
      name: job.name,
      payload: job.payload,
      status: 'pending',
      attempts: 0,
      createdAt: Date.now(),
    };
    record.attempts = job.attempt;
    record.status = 'running';
    record.error = undefined;
    records.set(job.id, record);

    try {
      let result: unknown;
      if (meta.timeoutMs !== undefined && meta.timeoutMs > 0) {
        result = await (deps.runIsolated ?? runTaskInWorker)({
          taskModulePath: path.resolve(rootDir, meta.filePath),
          payload: job.payload,
          taskCtx: {
            config: deps.config,
            job: { id: job.id, name: job.name, attempt: job.attempt },
          },
          timeoutMs: meta.timeoutMs,
          externalSignal: job.signal,
        });
      } else {
        let mod = moduleCache.get(job.name);
        if (!mod) {
          mod = await loadTaskModule(path.resolve(rootDir, meta.filePath));
          moduleCache.set(job.name, mod);
        }
        if (typeof mod.run !== 'function') {
          throw new Error(`Task "${job.name}" module has no run export`);
        }
        const taskCtx: TaskContext = {
          signal: job.signal,
          config: deps.config,
          job: { id: job.id, name: job.name, attempt: job.attempt },
        };
        result = await mod.run(job.payload, taskCtx);
      }
      record.status = 'done';
      record.result = result;
      return result;
    } catch (err) {
      // 取消（执行被框架终止：隔离执行超时终止 / 停机取消）与 run 自身失败分开记，
      // list() 可区分"任务被取消"与"任务出错"；两者都向上抛错交驱动按 retries 重试
      const cancelled = err instanceof TaskCancelledError || job.signal.aborted;
      record.status = cancelled ? 'cancelled' : 'failed';
      record.error = err instanceof Error ? err.message : String(err);
      // onFailed 副作用钩子（告警/死信上报）：willRetry 按 meta.retries 推算，
      // 自身抛错被忽略——不影响驱动重试决策
      if (deps.onFailed) {
        void Promise.resolve()
          .then(() =>
            deps.onFailed!({
              task: job.name,
              jobId: job.id,
              attempt: job.attempt,
              willRetry: job.attempt <= (meta.retries ?? 0),
              cancelled,
              error: record.error!,
            }),
          )
          .catch(() => {});
      }
      throw err; // 交给驱动决定重试
    }
  }

  async function startWorkers(): Promise<void> {
    for (const meta of registry.list()) {
      await driver.startWorker(meta.name, {
        concurrency: meta.concurrency ?? 1,
        process: runJob,
      });
    }
  }

  const queue: TaskQueue = {
    async enqueue(name, payload = {}, opts) {
      if (stopped) {
        throw new Error('[faapi] Task queue is stopped and no longer accepts jobs');
      }
      assertKnownTask(name);
      const data = await validatePayload(name, payload);
      const meta = registry.get(name)!;
      const id = await driver.enqueue(name, data, {
        delayMs: opts?.delayMs,
        retries: meta.retries ?? 0,
        dedupId: opts?.dedupId,
      });
      // driver.enqueue 可能已同步触发派发——runJob 已写入
      // running/done 记录时不要用 pending 覆盖
      if (!records.has(id)) {
        records.set(id, {
          id,
          name,
          payload: data,
          status: 'pending',
          attempts: 0,
          createdAt: Date.now(),
          ...(opts?.delayMs ? { runAt: Date.now() + opts.delayMs } : {}),
        });
      }
      return { id };
    },

    list(name?: string): TaskJob[] {
      const snapshot: TaskJob[] = [];
      for (const job of records.values()) {
        if (name !== undefined && job.name !== name) continue;
        snapshot.push({ ...job });
      }
      return snapshot;
    },

    async listQueued(name?: string): Promise<TaskJob[]> {
      if (!driver.list) {
        throw new Error(
          "[faapi] Task driver does not support listing queued tasks (TaskDriver.list is not implemented). Use the queue system's own management tools, or see driverTypes.md for per-driver capability.",
        );
      }
      const queued = await driver.list({ name, limit: 50 });
      const merged = new Map<string, TaskJob>();
      for (const record of queued) {
        // name 过滤语义层兜底（不依赖驱动实现的过滤正确性）
        if (name !== undefined && record.name !== name) continue;
        merged.set(record.id, {
          id: record.id,
          name: record.name,
          payload: record.payload,
          status: record.status,
          attempts: record.attempts,
          createdAt: record.createdAt,
          ...(record.result !== undefined ? { result: record.result } : {}),
          ...(record.error !== undefined ? { error: record.error } : {}),
          ...(record.runAt !== undefined ? { runAt: record.runAt } : {}),
        });
      }
      // 本进程执行记录优先（attempts/status/result/error 更实时），覆盖驱动侧同 id 记录
      for (const local of records.values()) {
        if (name !== undefined && local.name !== name) continue;
        merged.set(local.id, { ...local });
      }
      return [...merged.values()];
    },

    async cancel(name: string, id: string): Promise<void> {
      if (!driver.cancel) {
        throw new Error(
          '[faapi] Task driver does not support cancelling tasks (TaskDriver.cancel is not implemented).',
        );
      }
      await driver.cancel(name, id);
      const record = records.get(id);
      if (record) record.status = 'cancelled';
    },

    async retry(name: string, id: string): Promise<void> {
      if (!driver.retry) {
        throw new Error(
          '[faapi] Task driver does not support retrying tasks (TaskDriver.retry is not implemented).',
        );
      }
      await driver.retry(name, id);
      const record = records.get(id);
      if (record) record.status = 'pending'; // 等待驱动重新派发
    },

    async start() {
      if (stopped) {
        throw new Error('[faapi] Task queue is stopped and cannot be restarted');
      }
      if (started) return;
      started = true;
      await startWorkers();
    },

    async stop(timeoutMs = 10_000) {
      stopped = true;
      await driver.stop(timeoutMs);
    },

    async reload() {
      // dev reloadTasks：重注册 worker（驱动连接保持）；模块/schema 缓存由调用方清理
      await driver.stopWorkers?.();
      await startWorkers();
    },

    invalidateModules() {
      moduleCache.clear();
    },

    invalidateSchemas() {
      schemaCache.clear();
    },
  };

  return queue;
}
