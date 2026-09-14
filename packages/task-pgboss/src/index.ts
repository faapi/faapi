import { createHash } from 'node:crypto';
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
 * - `enqueue` → 幂等 ensureQueue + `boss.send(name, payload, { retryLimit, retryDelay, retryBackoff, startAfter })`
 * - `startWorker` → 幂等 ensureQueue + `boss.work(name, { batchSize: concurrency, includeMetadata: true }, handler)`
 * - `stop` → `offWork` + `boss.stop({ close: true, graceful: true, timeout })`；超时后 abort 在跑任务的 signal
 * - 重试 → pg-boss 侧执行（retryLimit + retryBackoff 指数退避）
 */
/**
 * dedupId → 确定性 UUID：pg-boss 的 send 自定义 id 要求 UUID 格式（SQL 侧 cast），
 * 任意字符串键经 SHA-1 映射为合法 UUID——同键必同 UUID（幂等），不同键碰撞可忽略
 */
function dedupIdToUuid(dedupId: string): string {
  const h = createHash('sha1').update(dedupId).digest('hex');
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    `5${h.slice(13, 16)}`, // version 5
    `${((parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}`, // variant
    h.slice(20, 32),
  ].join('-');
}

export function createPgBossDriver(options: PgBossDriverOptions = {}): TaskDriver {
  let boss: PgBoss | null = null;
  let stopped = false;
  /** 已创建的 pg-boss worker id（stopWorkers 时 offWork） */
  const workerIds = new Map<string, string>();
  /** 在跑任务的取消控制器（stop 超时 abort——run 监听 signal 可尽快退出） */
  const inflight = new Map<string, AbortController>();
  /** 已建队列名缓存（每任务名每进程一次真实 createQueue，之后短路） */
  const ensuredQueues = new Set<string>();
  /** 并发首次投递同名任务的 in-flight 去重 */
  const ensuring = new Map<string, Promise<void>>();
  /** boss.start() in-flight 共享 promise（并发首调等待同一次建连，不出现半启动实例） */
  let bossStarting: Promise<PgBoss> | null = null;

  async function ensureBoss(): Promise<PgBoss> {
    if (boss) return boss;
    if (!bossStarting) {
      bossStarting = (async () => {
        const b = new PgBoss(options);
        // pg-boss 惰性连接：start 后才连库；驱动在首次 enqueue/startWorker 前建立。
        // start 完成前实例不外借——pre-open 的 executeSql 静默 no-op（返回 undefined），
        // 建连中并发调用会在半启动实例上跑 SQL
        await b.start();
        boss = b;
        return b;
      })();
      // start 失败清空 in-flight：下次调用重新建连（坏实例不入缓存）
      void bossStarting.catch(() => {
        bossStarting = null;
      });
    }
    return bossStarting;
  }

  /**
   * pg-boss v10 不再隐式建队列（v9 行为）：send() 的 INSERT JOIN queue 对未创建队列
   * 静默返回 null，work() 只注册进程内轮询器同样不建队列——投递/注册 worker 前先建队列。
   * create_queue plpgsql 幂等（INSERT ON CONFLICT DO NOTHING，已存在直接返回），
   * 重复/并发调用安全；失败不入缓存，下次投递重试。
   */
  async function ensureQueue(b: PgBoss, name: string): Promise<void> {
    if (ensuredQueues.has(name)) return;
    const pending = ensuring.get(name);
    if (pending) return pending;
    const promise = (async () => {
      await b.createQueue(name);
      ensuredQueues.add(name);
    })().finally(() => {
      ensuring.delete(name);
    });
    ensuring.set(name, promise);
    return promise;
  }

  return {
    async enqueue(name, payload, opts) {
      if (stopped) {
        throw new Error('[faapi] Task queue is stopped and no longer accepts jobs');
      }
      const b = await ensureBoss();
      await ensureQueue(b, name);
      const sendOptions: PgBoss.SendOptions = {
        retryLimit: opts?.retries ?? 0,
        retryDelay: 1, // 秒；配合 retryBackoff 指数退避
        retryBackoff: true,
        ...(opts?.dedupId ? { id: dedupIdToUuid(opts.dedupId) } : {}),
        ...(opts?.delayMs ? { startAfter: new Date(Date.now() + opts.delayMs) } : {}),
      };
      // pg-boss data 形参为 object——基础类型 payload（cron 空任务等）按 JSON 语义透传
      const id = await b.send(name, payload as object, sendOptions);
      if (!id) {
        // dedupId 幂等投递：同键已存在（主键冲突 DO NOTHING → send 返回 null），
        // 返回已存在任务的确定性 id；无 dedupId 的失败投递才是异常
        if (opts?.dedupId) {
          return dedupIdToUuid(opts.dedupId);
        }
        throw new Error(`[faapi] pg-boss send failed for task "${name}"`);
      }
      return id;
    },

    async startWorker(name, workerOpts) {
      const b = await ensureBoss();
      await ensureQueue(b, name);
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
            // 信号由驱动自管：stop 超时 abort（pg-boss 自身不提供执行中任务的取消能力）
            const controller = new AbortController();
            inflight.set(job.id, controller);
            try {
              await process({
                id: job.id,
                name,
                payload: job.data,
                attempt,
                signal: controller.signal,
              });
            } finally {
              inflight.delete(job.id);
            }
          }
          // handler 正常返回 = 本批全部完成；抛错 = 整批失败由 pg-boss 按 retryLimit 重试
        },
      );
      workerIds.set(name, workerId);
    },

    async stop(timeoutMs = 10_000) {
      stopped = true;
      // 等待超时到点 abort 在跑任务（run 监听 signal 尽快退出）；等待结束后兜底 abort 残留
      const abortTimer = setTimeout(() => {
        for (const controller of inflight.values()) controller.abort();
      }, timeoutMs);
      try {
        const b = boss;
        bossStarting = null; // 停机后 ensureBoss 不再复用旧实例/旧建连 promise
        if (b) {
          for (const workerId of workerIds.values()) {
            await b.offWork(workerId).catch(() => {});
          }
          workerIds.clear();
          // graceful: 等 in-flight 任务完成；timeout 秒后强制处置
          await b.stop({ close: true, graceful: true, timeout: Math.floor(timeoutMs / 1000) });
          boss = null;
        }
      } finally {
        clearTimeout(abortTimer);
        for (const controller of inflight.values()) controller.abort();
        inflight.clear();
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

    async cancel(name, id) {
      if (stopped) {
        throw new Error(
          '[faapi] Task queue is stopped and no longer accepts management operations',
        );
      }
      const b = await ensureBoss();
      await b.cancel(name, id);
    },

    async retry(name, id) {
      if (stopped) {
        throw new Error(
          '[faapi] Task queue is stopped and no longer accepts management operations',
        );
      }
      const b = await ensureBoss();
      // pg-boss v10 语义：resume 恢复 cancelled 任务；failed 任务无原生重试 API
      await b.resume(name, id);
    },
    // list 未实现：pg-boss v10 无批量列出 jobs 的公开 API（getJobById/getQueueSize 只能单查/计数），
    // 不硬造内部 SQL 依赖——语义层 listQueued 显式抛错，管理走 pg-boss 自身 API/SQL
  };
}
