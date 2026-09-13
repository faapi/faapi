import type { TaskDriver, TaskDriverProcess } from '@faapi/faapi';
import PgBoss from 'pg-boss';

/**
 * pg-boss 驱动选项（透传给 PgBoss 构造函数）
 *
 * 常用：`connectionString`；其余见 pg-boss 文档（ConstructorOptions）。
 */
export type PgBossDriverOptions = PgBoss.ConstructorOptions;

/**
 * faapi 任务队列 pg-boss 驱动（PostgreSQL 持久化队列）
 *
 * 与 faapi 主包 `config.task.driver: 'pgboss'` 配合使用：
 *
 * ```ts
 * // faapi.config.ts
 * export default {
 *   task: {
 *     driver: 'pgboss',
 *     pgboss: { connectionString: 'postgres://localhost:5432/app' },
 *   },
 * } satisfies FaapiConfig;
 * ```
 *
 * 语义映射（详见包根 README）：
 * - `enqueue` → `boss.send(name, payload, { retryLimit, retryDelay, retryBackoff, startAfter })`
 * - `startWorker` → `boss.work(name, { batchSize: concurrency, includeMetadata: true }, handler)`
 * - `stop` → `offWork` + `boss.stop({ close: true, graceful: true, timeout })`
 * - 重试 → pg-boss 侧执行（retryLimit + retryBackoff 指数退避）
 */
export function createPgBossDriver(options: PgBossDriverOptions = {}): TaskDriver {
  let boss: PgBoss | null = null;
  let stopped = false;
  /** 已创建的 pg-boss worker id（stopWorkers 时 offWork） */
  const workerIds = new Map<string, string>();

  async function ensureBoss(): Promise<PgBoss> {
    if (!boss) {
      boss = new PgBoss(options);
      // pg-boss 惰性连接：start 后才连库；驱动在首次 enqueue/startWorker 前建立
      await boss.start();
    }
    return boss;
  }

  return {
    async enqueue(name, payload, opts) {
      if (stopped) {
        throw new Error('[faapi] Task queue is stopped and no longer accepts jobs');
      }
      const b = await ensureBoss();
      const sendOptions: PgBoss.SendOptions = {
        retryLimit: opts?.retries ?? 0,
        retryDelay: 1, // 秒；配合 retryBackoff 指数退避
        retryBackoff: true,
        ...(opts?.delayMs ? { startAfter: new Date(Date.now() + opts.delayMs) } : {}),
      };
      // pg-boss data 形参为 object——基础类型 payload（cron 空任务等）按 JSON 语义透传
      const id = await b.send(name, payload as object, sendOptions);
      if (!id) {
        throw new Error(`[faapi] pg-boss send failed for task "${name}"`);
      }
      return id;
    },

    async startWorker(name, workerOpts) {
      const b = await ensureBoss();
      const process: TaskDriverProcess = workerOpts.process;
      // 二次注册（reload 场景）先 offWork 旧 worker
      const existing = workerIds.get(name);
      if (existing) {
        await b.offWork(existing);
      }
      const workerId = await b.work<unknown>(
        name,
        { batchSize: workerOpts.concurrency, includeMetadata: true },
        async (jobs) => {
          for (const job of jobs) {
            // retryCount 从 0 起（首次执行为 0）→ faapi attempt 从 1 起
            const attempt = job.retryCount + 1;
            await process({
              id: job.id,
              name,
              payload: job.data,
              attempt,
              signal: new AbortController().signal, // pg-boss 不提供执行中任务的取消信号
            });
          }
          // handler 正常返回 = 本批全部完成；抛错 = 整批失败由 pg-boss 按 retryLimit 重试
        },
      );
      workerIds.set(name, workerId);
    },

    async stop(timeoutMs = 10_000) {
      stopped = true;
      const b = boss;
      if (b) {
        for (const workerId of workerIds.values()) {
          await b.offWork(workerId).catch(() => {});
        }
        workerIds.clear();
        // graceful: 等 in-flight 任务完成；timeout 秒后强制处置
        await b.stop({ close: true, graceful: true, timeout: Math.floor(timeoutMs / 1000) });
        boss = null;
      }
    },

    async stopWorkers() {
      const b = boss;
      if (b) {
        for (const workerId of workerIds.values()) {
          await b.offWork(workerId).catch(() => {});
        }
      }
      workerIds.clear();
    },
  };
}
