import type {
  TaskDriver,
  TaskDriverGroupCreate,
  TaskDriverGroupOps,
  TaskDriverProcess,
  TaskDriverRecord,
  TaskGroupSnapshot,
  TaskJobStatus,
} from '@faapi/faapi';
import {
  Queue,
  Worker,
  type ConnectionOptions,
  type Job,
  type JobType,
  type KeepJobs,
} from 'bullmq';

/**
 * BullMQ 驱动选项
 */
export interface BullMQDriverOptions {
  /** Redis 连接配置（透传给 Queue / Worker 的 connection） */
  connection: ConnectionOptions;
  /** 队列名前缀（默认 `faapi`——同一 Redis 下多个 faapi 应用隔离用） */
  prefix?: string;
  /**
   * 终态（completed）任务清理策略，透传 BullMQ `removeOnComplete`。
   * 默认 7 天后移除——BullMQ 默认永久保留终态任务，Redis 无界增长，且 dedupId
   * （jobId）去重在任务存活期内一直生效，周期性复用同一 dedupId 的投递（如
   * nightly-sync）会被永久静默忽略。传 `false` 恢复 BullMQ 默认（永不清理）。
   */
  removeOnComplete?: boolean | number | KeepJobs;
  /** 终态（failed）任务清理策略，透传 BullMQ `removeOnFail`，默认同上 */
  removeOnFail?: boolean | number | KeepJobs;
}

/** 终态任务默认保留秒数（7 天，与 pg-boss 默认保留策略同量级） */
const DEFAULT_KEEP_AGE_SECONDS = 7 * 24 * 3600;

/**
 * 成员组标识的载荷包装（组投递成员的传输载体）
 *
 * BullMQ 的 job 除 data（payload）外无任意元数据字段，组标识随载荷一起存储：
 * `enqueue(opts.groupId)` 时包装、worker 交付 / getJobs 查询时还原。仅组任务包装
 * （存量行为不变）；包装对业务不可见，`TaskDriverRecord.payload` 恒为业务原始
 * payload。业务 payload 恰为该形状（两保留键 + 无其他键）会被误解包——保留键为
 * 框架命名空间，业务 payload 不应占用。
 */
const GROUP_KEY = '__faapiGroup';
const PAYLOAD_KEY = '__faapiPayload';

function wrapGroupPayload(groupId: string, payload: unknown): object {
  return { [GROUP_KEY]: groupId, [PAYLOAD_KEY]: payload };
}

function unwrapGroupPayload(data: unknown): { payload: unknown; groupId?: string } {
  if (
    data !== null &&
    typeof data === 'object' &&
    !Array.isArray(data) &&
    (data as Record<string, unknown>)[GROUP_KEY] !== undefined &&
    typeof (data as Record<string, unknown>)[GROUP_KEY] === 'string' &&
    (data as Record<string, unknown>)[PAYLOAD_KEY] !== undefined &&
    Object.keys(data as Record<string, unknown>).length === 2
  ) {
    const wrapped = data as Record<string, unknown>;
    return { payload: wrapped[PAYLOAD_KEY], groupId: wrapped[GROUP_KEY] as string };
  }
  return { payload: data };
}

/**
 * 任务组记账存储（两组 Redis key，经 `Queue.client` 复用驱动连接——不加新连接）：
 * - `<prefix>:group:<id>`：组行（task/total/计数器/onComplete/onFailure/completionEnqueued）
 * - `<prefix>:group-members:<id>`：成员行（jobId → 'pending' | 's:<outcome>'），
 *   落定记账的幂等守卫（同一成员重复 settle 不重复计数）
 *
 * 组记录常驻 Redis（框架不自动清理——自动删业务可能还要查的记账是静默丢数据），
 * 业务方按保留策略自行清理。
 */

/** 组记账 Lua：原子 create（同 id 参数一致幂等返回 0 / 不一致返回 -1） */
const LUA_CREATE = `
if redis.call('EXISTS', KEYS[1]) == 1 then
  if redis.call('HGET', KEYS[1], 'task') == ARGV[1]
    and redis.call('HGET', KEYS[1], 'total') == ARGV[2]
    and (redis.call('HGET', KEYS[1], 'onComplete') or '') == ARGV[3]
    and redis.call('HGET', KEYS[1], 'onFailure') == ARGV[4] then
    return 0
  end
  return -1
end
redis.call('HSET', KEYS[1],
  'task', ARGV[1], 'total', ARGV[2], 'onComplete', ARGV[3], 'onFailure', ARGV[4],
  'done', 0, 'failed', 0, 'cancelled', 0, 'completionEnqueued', 0)
return 1`;

/** 组记账 Lua：原子 settle（成员行守卫幂等 + 计数递增；返回记账后计数） */
const LUA_SETTLE = `
if redis.call('EXISTS', KEYS[1]) == 0 then return {-1} end
local prev = redis.call('HGET', KEYS[2], ARGV[1])
if prev and prev ~= 'pending' then
  return {0,
    tonumber(redis.call('HGET', KEYS[1], 'done')) or 0,
    tonumber(redis.call('HGET', KEYS[1], 'failed')) or 0,
    tonumber(redis.call('HGET', KEYS[1], 'cancelled')) or 0,
    tonumber(redis.call('HGET', KEYS[1], 'total')) or 0,
    redis.call('HGET', KEYS[1], 'onComplete') or '',
    redis.call('HGET', KEYS[1], 'onFailure') or 'run-to-completion',
    tonumber(redis.call('HGET', KEYS[1], 'completionEnqueued')) or 0}
end
redis.call('HSET', KEYS[2], ARGV[1], 's:' .. ARGV[2])
redis.call('HINCRBY', KEYS[1], ARGV[2], 1)
return {1,
  tonumber(redis.call('HGET', KEYS[1], 'done')) or 0,
  tonumber(redis.call('HGET', KEYS[1], 'failed')) or 0,
  tonumber(redis.call('HGET', KEYS[1], 'cancelled')) or 0,
  tonumber(redis.call('HGET', KEYS[1], 'total')) or 0,
  redis.call('HGET', KEYS[1], 'onComplete') or '',
  redis.call('HGET', KEYS[1], 'onFailure') or 'run-to-completion',
  tonumber(redis.call('HGET', KEYS[1], 'completionEnqueued')) or 0}`;

/** 组记账 Lua：原子 unsettle（成员行守卫 + 按原 outcome 递减；未落定 no-op） */
const LUA_UNSETTLE = `
if redis.call('EXISTS', KEYS[1]) == 0 then return -1 end
local prev = redis.call('HGET', KEYS[2], ARGV[1])
if not prev or string.sub(prev, 1, 2) ~= 's:' then return 0 end
redis.call('HSET', KEYS[2], ARGV[1], 'pending')
redis.call('HINCRBY', KEYS[1], string.sub(prev, 3), -1)
return 1`;

/** 组记账 Lua：成员登记的 set-if-absent（IRedisClient 无 hsetnx——防覆盖已落定成员态） */
const LUA_HSETNX = `
if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 0 then
  redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
  return 1
end
return 0`;

/** defineCommand 注册名（组记账脚本经 runCommand 调用） */
const GROUP_CREATE_CMD = 'faapiGroupCreate';
const GROUP_SETTLE_CMD = 'faapiGroupSettle';
const GROUP_UNSETTLE_CMD = 'faapiGroupUnsettle';
const GROUP_HSETNX_CMD = 'faapiGroupMemberHsetnx';

/**
 * faapi 任务队列 BullMQ 驱动（Redis 持久化队列）
 *
 * 与 faapi 主包 `config.task.driver: 'bullmq'` 配合使用：
 *
 * ```ts
 * // faapi.config.ts
 * export default {
 *   task: {
 *     driver: 'bullmq',
 *     bullmq: { connection: { host: '127.0.0.1', port: 6379 } },
 *   },
 * } satisfies FaapiConfig;
 * ```
 *
 * 语义映射（详见包根 README）：
 * - `enqueue` → `queue.add(name, payload, { delay, attempts, backoff, removeOnComplete, removeOnFail })`（每任务一个 Queue）
 * - `startWorker` → `new Worker(name, handler, { connection, concurrency })`；attempt 取 job.attemptsStarted
 * - `stop` → workers.close() + queues.close()（等 in-flight；超时 abort 在跑任务的 signal）
 * - 重试 → BullMQ 侧执行（attempts = retries + 1，指数退避 500ms 起）
 */
export function createBullMQDriver(options: BullMQDriverOptions): TaskDriver {
  if (!options?.connection) {
    throw new Error('[faapi] @faapi/task-bullmq requires `bullmq.connection` in config.task');
  }
  const prefix = options.prefix ?? 'faapi';

  let stopped = false;
  /** 每任务一个 Queue（按名缓存） */
  const queues = new Map<string, Queue>();
  /** 已创建的 Worker（stopWorkers / stop 时关闭） */
  const workers = new Map<string, Worker>();
  /** 在跑任务的取消控制器（stop 超时 abort——run 监听 signal 可尽快退出） */
  const inflight = new Map<string, AbortController>();
  /** 终态清理策略（默认 7 天移除，false 透传恢复 BullMQ 永不清理） */
  const removeOnComplete = options.removeOnComplete ?? { age: DEFAULT_KEEP_AGE_SECONDS };
  const removeOnFail = options.removeOnFail ?? { age: DEFAULT_KEEP_AGE_SECONDS };

  function getQueue(name: string): Queue {
    let q = queues.get(name);
    if (!q) {
      q = new Queue(name, { connection: options.connection, prefix });
      queues.set(name, q);
    }
    return q;
  }

  const groupKey = (groupId: string) => `${prefix}:group:${groupId}`;
  const groupMembersKey = (groupId: string) => `${prefix}:group-members:${groupId}`;

  /**
   * 组记账专用连接（BullMQ 底层 ioredis client——经 backend.client 复用连接池，
   * 不加新连接）。独立 Queue 实例且不进 `queues` map（避免泄入 list() 的已建
   * 队列遍历）；Queue 构造惰性建连，仅组记账命令实际触达 Redis。
   */
  let groupOpsQueue: Queue | null = null;
  async function groupClient() {
    if (!groupOpsQueue) {
      groupOpsQueue = new Queue('__faapi_group_ops__', {
        connection: options.connection,
        prefix,
      });
    }
    const client = await groupOpsQueue.backend.client;
    // 组记账脚本按 BullMQ 类型化扩展口注册（defineCommand + runCommand）——每个
    // 连接实例注册一次（同名重复注册幂等）
    client.defineCommand(GROUP_CREATE_CMD, { numberOfKeys: 2, lua: LUA_CREATE });
    client.defineCommand(GROUP_SETTLE_CMD, { numberOfKeys: 2, lua: LUA_SETTLE });
    client.defineCommand(GROUP_UNSETTLE_CMD, { numberOfKeys: 2, lua: LUA_UNSETTLE });
    client.defineCommand(GROUP_HSETNX_CMD, { numberOfKeys: 1, lua: LUA_HSETNX });
    return client;
  }

  /** settle Lua 返回行（[changed, done, failed, cancelled, total, onComplete, onFailure, ce]）→ 快照 */
  function settleRowToSnapshot(groupId: string, row: unknown[]): TaskGroupSnapshot {
    const num = (i: number) => Number(row[i]);
    const done = num(1);
    const failed = num(2);
    const cancelled = num(3);
    const total = num(4);
    const onComplete = String(row[5] ?? '');
    const onFailure = String(row[6] ?? 'run-to-completion');
    const completionEnqueued = num(7) === 1;
    const settled = done + failed + cancelled;
    return {
      groupId,
      task: '',
      total,
      done,
      failed,
      cancelled,
      settled,
      status: settled >= total ? 'settled' : 'open',
      completionEnqueued,
      ...(onComplete !== '' ? { onComplete } : {}),
      onFailure: onFailure as TaskGroupSnapshot['onFailure'],
    };
  }

  /**
   * 组记账实现（TaskDriver.groups）——经 backend.client 的 defineCommand/runCommand
   * （BullMQ 类型化 Lua 扩展口）计账。落定幂等由成员行状态守卫承载，成员翻转 +
   * 计数递增在 Lua 内原子；记账状态持久化在 Redis，跨实例/重启正确。
   */
  function createGroupOps(): TaskDriverGroupOps {
    return {
      async create(decl: TaskDriverGroupCreate): Promise<void> {
        const c = await groupClient();
        const result = (await c.runCommand(GROUP_CREATE_CMD, [
          groupKey(decl.id),
          groupMembersKey(decl.id),
          decl.task,
          String(decl.total),
          decl.onComplete ?? '',
          decl.onFailure,
        ])) as number;
        if (result === 0) return;
        if (result === -1) {
          // 同 id 已存在且参数漂移——静默沿用旧声明会让 fan-in 指向错误的回调任务
          const existing = (await c.hgetall(groupKey(decl.id))) as Record<string, string>;
          throw new Error(
            `[faapi] Task group "${decl.id}" already exists with different options ` +
              `(existing: task=${existing.task}, total=${existing.total}, ` +
              `onComplete=${existing.onComplete || '(none)'}, onFailure=${existing.onFailure})`,
          );
        }
      },

      async settle(groupId, jobId, outcome) {
        const c = await groupClient();
        const row = (await c.runCommand(GROUP_SETTLE_CMD, [
          groupKey(groupId),
          groupMembersKey(groupId),
          jobId,
          outcome,
        ])) as unknown[];
        if (Number(row[0]) === -1) {
          throw new Error(`[faapi] Task group "${groupId}" not found`);
        }
        const snap = settleRowToSnapshot(groupId, row);
        return { ...snap, isLast: snap.settled >= snap.total };
      },

      async unsettle(groupId, jobId) {
        const c = await groupClient();
        await c.runCommand(GROUP_UNSETTLE_CMD, [
          groupKey(groupId),
          groupMembersKey(groupId),
          jobId,
        ]);
      },

      async markCompletionEnqueued(groupId) {
        const c = await groupClient();
        await c.hset(groupKey(groupId), { completionEnqueued: 1 });
      },

      async get(groupId) {
        const c = await groupClient();
        const row = (await c.hgetall(groupKey(groupId))) as Record<string, string>;
        if (!row || Object.keys(row).length === 0) return undefined;
        const done = Number(row.done ?? 0);
        const failed = Number(row.failed ?? 0);
        const cancelled = Number(row.cancelled ?? 0);
        const total = Number(row.total ?? 0);
        const settled = done + failed + cancelled;
        return {
          groupId,
          task: row.task ?? '',
          total,
          done,
          failed,
          cancelled,
          settled,
          status: settled >= total ? 'settled' : 'open',
          completionEnqueued: row.completionEnqueued === '1',
          ...(row.onComplete ? { onComplete: row.onComplete } : {}),
          onFailure: (row.onFailure ?? 'run-to-completion') as TaskGroupSnapshot['onFailure'],
        };
      },

      async cancelRemaining(groupId) {
        const snap = await this.get(groupId);
        if (snap === undefined) {
          throw new Error(`[faapi] Task group "${groupId}" not found`);
        }
        // 仅 fail-fast 组执行取消语义（run-to-completion 为 no-op，返回当前快照）
        if (snap.onFailure !== 'fail-fast') return snap;
        const c = await groupClient();
        const members = (await c.hgetall(groupMembersKey(groupId))) as Record<string, string>;
        for (const [jobId, memberState] of Object.entries(members)) {
          if (memberState !== 'pending') continue;
          const job = await getQueue(snap.task).getJob(jobId);
          if (!job) continue;
          // 仅取消等待/延迟中的成员（在跑的自然跑完；仅此两状态取消语义可靠），
          // 实际移除成功才落定 cancelled（幂等守卫防与运行实例的落定竞态重复计数）
          const jobState = await job.getState();
          if (jobState === 'waiting' || jobState === 'delayed') {
            await job.remove();
            await this.settle(groupId, jobId, 'cancelled');
          }
        }
        const after = await this.get(groupId);
        return after!;
      },
    };
  }

  return {
    async enqueue(name, payload, opts) {
      if (stopped) {
        throw new Error('[faapi] Task queue is stopped and no longer accepts jobs');
      }
      const queue = getQueue(name);
      const job = await queue.add(
        name,
        // 组投递成员以载荷包装携带组标识（交付时还原，业务 payload 不变）
        opts?.groupId !== undefined ? wrapGroupPayload(opts.groupId, payload) : payload,
        {
          // BullMQ attempts 含首次执行，retries 是额外重试次数
          attempts: (opts?.retries ?? 0) + 1,
          backoff: { type: 'exponential', delay: 500 },
          // 终态任务定时移除：防 Redis 无界增长 + 限定 dedupId 去重的存活期
          removeOnComplete,
          removeOnFail,
          // dedupId 幂等键：同 jobId 的 job 存活期内 add 被忽略（BullMQ 原生去重）
          ...(opts?.dedupId ? { jobId: opts.dedupId } : {}),
          ...(opts?.delayMs ? { delay: opts.delayMs } : {}),
        },
      );
      const id = job.id ?? crypto.randomUUID();
      // 组投递成员登记（成员 hash = 落定记账的幂等守卫载体；set-if-absent——
      // 幂等命中不覆盖已落定成员态，重复投递不重复登记）
      if (opts?.groupId !== undefined) {
        const c = await groupClient();
        await c.runCommand(GROUP_HSETNX_CMD, [groupMembersKey(opts.groupId), id, 'pending']);
      }
      return id;
    },

    async startWorker(name, workerOpts) {
      const process: TaskDriverProcess = workerOpts.process;
      // 二次注册（reload 场景）先关旧 Worker
      const existing = workers.get(name);
      if (existing) {
        await existing.close();
      }
      const worker = new Worker(
        name,
        async (job: Job) => {
          const id = job.id ?? '';
          // attemptsStarted 由 BullMQ 维护（首次执行为 1，重试递增，跨实例/重启准确）——
          // 进程内自计数会内存泄漏且多实例/重启后失真
          const attempt = job.attemptsStarted;
          // 组投递成员：从载荷包装还原业务 payload 与组标识（语义层据此记账）
          const { payload, groupId } = unwrapGroupPayload(job.data);
          // 信号由驱动自管：stop 超时 abort（BullMQ 自身不提供执行中任务的取消能力）
          const controller = new AbortController();
          inflight.set(id, controller);
          try {
            return await process({
              id,
              name,
              payload,
              attempt,
              signal: controller.signal,
              ...(groupId !== undefined ? { groupId } : {}),
            });
          } finally {
            inflight.delete(id);
          }
        },
        { connection: options.connection, concurrency: workerOpts.concurrency, prefix },
      );
      // 处理器内部异常已由语义层包装记录；这里兜底防止 unhandled error 事件崩进程
      worker.on('error', (err) => {
        console.error(`[faapi] bullmq worker error for task "${name}":`, err);
      });
      workers.set(name, worker);
    },

    async stop(timeoutMs = 10_000) {
      stopped = true;
      // 等待超时到点 abort 在跑任务（run 监听 signal 可尽快退出）；等待结束后兜底 abort 残留
      const abortTimer = setTimeout(() => {
        for (const controller of inflight.values()) controller.abort();
      }, timeoutMs);
      try {
        const closes = [
          ...Array.from(workers.values()).map((w) => w.close()),
          ...Array.from(queues.values()).map((q) => q.close()),
        ];
        workers.clear();
        const timeout = new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, timeoutMs);
          timer.unref?.();
        });
        await Promise.race([Promise.all(closes), timeout]);
      } finally {
        clearTimeout(abortTimer);
        for (const controller of inflight.values()) controller.abort();
        inflight.clear();
      }
    },

    async stopWorkers() {
      const closes = Array.from(workers.values()).map((w) => w.close());
      workers.clear();
      await Promise.all(closes);
    },

    async list(opts) {
      const limit = opts?.limit ?? 50;
      // 目标队列：指定 name 时按需创建 Queue 实例；不传时遍历本进程已创建的
      // （BullMQ 队列按 Redis key 寻址，额外实例不影响驱动内的队列）
      const targets: Queue[] = opts?.name ? [getQueue(opts.name)] : [...queues.values()];
      // faapi 语义状态 → BullMQ JobType 分组（cancel 为 job.remove，无 cancelled 可查；
      // 重试等待中的 job 处于 delayed → 归入 pending）
      const stateTypes: Partial<Record<TaskJobStatus, JobType[]>> = {
        pending: ['waiting', 'delayed'],
        running: ['active'],
        done: ['completed'],
        failed: ['failed'],
      };
      const wanted = (opts?.state ? [opts.state] : ['pending', 'running', 'done', 'failed']).filter(
        (s): s is TaskJobStatus => (stateTypes[s as TaskJobStatus]?.length ?? 0) > 0,
      );

      const records: TaskDriverRecord[] = [];
      for (const status of wanted) {
        const types = stateTypes[status]!;
        for (const queue of targets) {
          const jobs = await queue.getJobs(types, 0, limit - 1);
          for (const job of jobs) {
            if (!job) continue;
            // 组投递成员：从载荷包装还原业务 payload 与组标识（记录对业务不可见包装）
            const { payload, groupId } = unwrapGroupPayload(job.data);
            records.push({
              id: job.id ?? '',
              name: job.name,
              payload,
              status,
              attempts: job.attemptsStarted ?? job.attemptsMade ?? 0,
              ...(job.returnvalue !== undefined && job.returnvalue !== null
                ? { result: job.returnvalue }
                : {}),
              ...(job.failedReason ? { error: job.failedReason } : {}),
              ...(groupId !== undefined ? { groupId } : {}),
              createdAt: job.timestamp,
              ...(job.processedOn ? { runAt: job.processedOn } : {}),
            });
          }
        }
      }
      return records.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
    },

    async cancel(name, id) {
      if (stopped) {
        throw new Error(
          '[faapi] Task queue is stopped and no longer accepts management operations',
        );
      }
      // BullMQ 无 cancelled 状态——取消即移除（等待/延迟中的不再执行；active 受锁限制由 BullMQ 抛错）
      const job = await getQueue(name).getJob(id);
      if (job) await job.remove();
    },

    async retry(name, id) {
      if (stopped) {
        throw new Error(
          '[faapi] Task queue is stopped and no longer accepts management operations',
        );
      }
      const job = await getQueue(name).getJob(id);
      if (!job) {
        throw new Error(`[faapi] Task "${name}" job "${id}" not found`);
      }
      await job.retry(); // 仅 failed 可重试；其余状态由 BullMQ 抛错
    },

    groups: createGroupOps(),
  };
}
