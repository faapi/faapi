import { createHash } from 'node:crypto';
import type {
  TaskDriver,
  TaskDriverGroupCreate,
  TaskDriverGroupOps,
  TaskDriverProcess,
  TaskDriverRecord,
  TaskGroupSnapshot,
} from '@faapi/faapi';
import { PgBoss } from 'pg-boss';
import type { ConstructorOptions, SendOptions } from 'pg-boss';

/**
 * pg-boss 驱动选项
 *
 * `defaultExpireSeconds` 之外全部透传给 PgBoss 构造函数（常用：`connectionString`，
 * 其余见 pg-boss 文档 ConstructorOptions）。
 */
export type PgBossDriverOptions = ConstructorOptions & {
  /**
   * 未声明 `timeoutMs` 的任务的 expire_in 兜底秒数（默认 24h − 1s）。
   *
   * pg-boss 以 job 的 expire_in 硬限 handler 执行（DDL 默认 15 分钟）：超时判失败
   * 重试，而任务还在后台跑 → 同一任务两份并发执行。声明了 `timeoutMs` 的任务由
   * 驱动按 `timeoutMs + graceMs + 60s` 缓冲给足；未声明的任务用本兜底。
   * 默认 24h − 1s：pg-boss 12.28 前断言 `expireIn/3600 < 24`（排他），减 1 秒落
   * 界内（12.28 起放宽到允许恰好 24h，保守值对两者都安全）；显式配置超过 86399
   * 在 12.28 前的版本会被 send 参数校验阶段拒绝。
   *
   * 声明侧上界由主包 `scanTasks` 构建期校验（`MAX_ISOLATED_TIMEOUT_MS` 23h），
   * 保证 `timeoutMs + graceMs + 缓冲` 的 expire 预算恒落在断言界内。
   */
  defaultExpireSeconds?: number;
};

/**
 * 成员组标识的载荷包装（组投递成员的传输载体）
 *
 * pg-boss 的 job 除 data（payload）外无任意元数据字段，组标识随载荷一起存储：
 * `enqueue(opts.groupId)` 时包装、work 交付 / findJobs 查询时还原。仅组任务包装
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
 * 任务组记账表（同库自建，与 pg-boss 自身 schema 表无关）
 *
 * 组行 = 计数器 + 完成回调声明 + 失败策略；成员行 = job 级 settled/outcome，
 * 落定记账的幂等守卫（同一成员重复 settle 不重复计数）。首次组操作时
 * CREATE TABLE IF NOT EXISTS，业务方按保留策略自行清理（框架不自动删——
 * 自动删业务可能还要查的记账是静默丢数据）。
 */
const GROUP_TABLES_SQL = [
  `CREATE TABLE IF NOT EXISTS faapi_task_groups (
  id text PRIMARY KEY,
  task text NOT NULL,
  total integer NOT NULL,
  done integer NOT NULL DEFAULT 0,
  failed integer NOT NULL DEFAULT 0,
  cancelled integer NOT NULL DEFAULT 0,
  on_complete text,
  on_failure text NOT NULL,
  completion_enqueued boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
)`,
  `CREATE TABLE IF NOT EXISTS faapi_task_group_members (
  group_id text NOT NULL,
  job_id text NOT NULL,
  settled boolean NOT NULL DEFAULT false,
  outcome text,
  PRIMARY KEY (group_id, job_id)
)`,
];

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
 * - `enqueue` → 幂等 ensureQueue + `boss.send(name, payload, { retryLimit, retryDelay, retryBackoff, expireInSeconds, startAfter })`；
 *   组投递成员（opts.groupId）以载荷包装携带组标识并在成员表登记
 * - `startWorker` → 幂等 ensureQueue + `boss.work(name, { batchSize: concurrency, includeMetadata: true }, handler)`；
 *   批内任务并发执行、逐任务 complete/fail 结算（失败不毒化同批）；交付时从载荷
 *   包装还原 groupId
 * - `stop` → `offWork` + `boss.stop({ close: true, graceful: true, timeout })` 整体与
 *   deadline 竞速；deadline 到点 abort 在跑任务的 signal
 * - 重试 → pg-boss 侧执行（retryLimit + retryBackoff 指数退避）
 * - `list` → `boss.findJobs(name)`（v12）：六态精确映射（created→pending、retry→retry、
 *   active→running、completed→done、failed→failed、cancelled→cancelled）；不传 name
 *   遍历本进程已 ensureQueue 的任务名；createdAt 降序截断 limit
 * - `groups` → 同库两张表（faapi_task_groups / faapi_task_group_members）经
 *   `boss.getDb().executeSql` 计账：成员行 settled 守卫保证落定幂等，CTE 内
 *   成员翻转 + 计数递增单语句原子
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

/** 未声明 timeoutMs 的任务 expire_in 兜底（秒）——pg-boss 12.28 前断言 expireIn/3600 < 24
 * （严格小于），顶到 24h 整会让 send() 在参数校验阶段必抛 AssertionError，减 1 秒落界内
 * （12.28 起放宽到允许恰好 24h，保守值对两者都安全） */
const DEFAULT_EXPIRE_SECONDS = 24 * 60 * 60 - 1;
/** expire_in 在任务执行预算之外的缓冲（秒）——留出调度/网络抖动余量 */
const EXPIRE_BUFFER_SECONDS = 60;
/** graceMs 未声明时的默认值（与主包 taskWorker 的取消宽限期默认一致） */
const DEFAULT_GRACE_MS = 5000;

export function createPgBossDriver(driverOptions: PgBossDriverOptions = {}): TaskDriver {
  const { defaultExpireSeconds, ...options } = driverOptions;
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
  /** 组记账表已确保（每进程一次 CREATE TABLE IF NOT EXISTS，之后短路） */
  let groupTablesEnsured = false;

  async function ensureGroupTables(b: PgBoss): Promise<void> {
    if (groupTablesEnsured) return;
    const db = b.getDb();
    for (const sql of GROUP_TABLES_SQL) {
      await db.executeSql(sql, []);
    }
    groupTablesEnsured = true;
  }

  /** 组行 → TaskGroupSnapshot（行字段 snake_case → 快照契约） */
  function rowToSnapshot(row: Record<string, unknown>): TaskGroupSnapshot {
    const done = Number(row.done);
    const failed = Number(row.failed);
    const cancelled = Number(row.cancelled);
    const total = Number(row.total);
    const settled = done + failed + cancelled;
    return {
      groupId: String(row.id),
      task: String(row.task),
      total,
      done,
      failed,
      cancelled,
      settled,
      status: settled >= total ? 'settled' : 'open',
      completionEnqueued: row.completion_enqueued === true,
      ...(row.on_complete !== null && row.on_complete !== undefined
        ? { onComplete: String(row.on_complete) }
        : {}),
      onFailure: String(row.on_failure) as TaskGroupSnapshot['onFailure'],
    };
  }

  /**
   * 组记账实现（TaskDriver.groups）——经 boss.getDb().executeSql 计账。
   * 落定幂等由成员行 settled 守卫承载；成员翻转 + 计数递增在单条 CTE 语句内原子。
   */
  function createGroupOps(getBoss: () => Promise<PgBoss>): TaskDriverGroupOps {
    return {
      async create(decl: TaskDriverGroupCreate): Promise<void> {
        const b = await getBoss();
        await ensureGroupTables(b);
        const db = b.getDb();
        const inserted = await db.executeSql(
          `INSERT INTO faapi_task_groups (id, task, total, on_complete, on_failure)
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING RETURNING id`,
          [decl.id, decl.task, decl.total, decl.onComplete ?? null, decl.onFailure],
        );
        if (inserted.rows.length > 0) return;
        // 同 id 已存在：参数完全一致幂等跳过；不一致抛错（组标识是业务关联键，
        // 形状漂移属调用方错误——静默沿用旧声明会让 fan-in 指向错误的回调任务）
        const existing = await db.executeSql(
          `SELECT task, total, on_complete, on_failure FROM faapi_task_groups WHERE id = $1`,
          [decl.id],
        );
        const row = existing.rows[0] as Record<string, unknown> | undefined;
        const same =
          row !== undefined &&
          row.task === decl.task &&
          Number(row.total) === decl.total &&
          (row.on_complete ?? null) === (decl.onComplete ?? null) &&
          row.on_failure === decl.onFailure;
        if (!same) {
          throw new Error(
            `[faapi] Task group "${decl.id}" already exists with different options ` +
              `(existing: task=${row?.task}, total=${row?.total}, onComplete=${row?.on_complete}, ` +
              `onFailure=${row?.on_failure})`,
          );
        }
      },

      async settle(groupId, jobId, outcome) {
        const b = await getBoss();
        await ensureGroupTables(b);
        const db = b.getDb();
        // 单语句原子：成员行 settled 守卫翻转（已落定成员返回 0 行 → 不递增）+
        // 组行计数按 outcome 递增 + 返回记账后快照
        const result = await db.executeSql(
          `WITH member AS (
             INSERT INTO faapi_task_group_members (group_id, job_id, settled, outcome)
             VALUES ($1, $2, true, $3)
             ON CONFLICT (group_id, job_id) DO UPDATE
               SET settled = true, outcome = EXCLUDED.outcome
             WHERE faapi_task_group_members.settled = false
             RETURNING job_id
           )
           UPDATE faapi_task_groups g
           SET done = done + CASE WHEN $3 = 'done' THEN 1 ELSE 0 END,
               failed = failed + CASE WHEN $3 = 'failed' THEN 1 ELSE 0 END,
               cancelled = cancelled + CASE WHEN $3 = 'cancelled' THEN 1 ELSE 0 END
           FROM member
           WHERE g.id = $1
           RETURNING g.id, g.task, g.total, g.done, g.failed, g.cancelled,
                     g.on_complete, g.on_failure, g.completion_enqueued`,
          [groupId, jobId, outcome],
        );
        const row = result.rows[0] as Record<string, unknown> | undefined;
        if (row !== undefined) {
          const snap = rowToSnapshot(row);
          return { ...snap, isLast: snap.settled >= snap.total };
        }
        // 成员已落定（重复 settle）：计数不变，返回当前快照（isLast=false——
        // 重复落定不重新触发 fan-in；回调自身还有 dedupId + completionEnqueued 双守卫）
        const current = await db.executeSql(
          `SELECT id, task, total, done, failed, cancelled, on_complete, on_failure,
                  completion_enqueued
           FROM faapi_task_groups WHERE id = $1`,
          [groupId],
        );
        const cur = current.rows[0] as Record<string, unknown> | undefined;
        if (cur === undefined) {
          throw new Error(`[faapi] Task group "${groupId}" not found`);
        }
        return { ...rowToSnapshot(cur), isLast: false };
      },

      async unsettle(groupId, jobId) {
        const b = await getBoss();
        const db = b.getDb();
        // 单语句原子：成员行 settled 守卫撤销（未落定成员返回 0 行 → 不递减）+
        // 组行计数按原 outcome 递减
        await db.executeSql(
          `WITH member AS (
             UPDATE faapi_task_group_members
             SET settled = false, outcome = NULL
             WHERE group_id = $1 AND job_id = $2 AND settled = true
             RETURNING outcome
           )
           UPDATE faapi_task_groups g
           SET done = done - CASE WHEN member.outcome = 'done' THEN 1 ELSE 0 END,
               failed = failed - CASE WHEN member.outcome = 'failed' THEN 1 ELSE 0 END,
               cancelled = cancelled - CASE WHEN member.outcome = 'cancelled' THEN 1 ELSE 0 END
           FROM member
           WHERE g.id = $1`,
          [groupId, jobId],
        );
      },

      async markCompletionEnqueued(groupId) {
        const b = await getBoss();
        const db = b.getDb();
        await db.executeSql(
          `UPDATE faapi_task_groups SET completion_enqueued = true WHERE id = $1`,
          [groupId],
        );
      },

      async get(groupId) {
        const b = await getBoss();
        const db = b.getDb();
        const result = await db.executeSql(
          `SELECT id, task, total, done, failed, cancelled, on_complete, on_failure,
                  completion_enqueued
           FROM faapi_task_groups WHERE id = $1`,
          [groupId],
        );
        const row = result.rows[0] as Record<string, unknown> | undefined;
        return row === undefined ? undefined : rowToSnapshot(row);
      },

      async cancelRemaining(groupId) {
        const b = await getBoss();
        const db = b.getDb();
        const group = await this.get(groupId);
        if (group === undefined) {
          throw new Error(`[faapi] Task group "${groupId}" not found`);
        }
        // 仅 fail-fast 组执行取消语义（run-to-completion 为 no-op，返回当前快照）
        if (group.onFailure !== 'fail-fast') return group;
        const pending = await db.executeSql(
          `SELECT job_id FROM faapi_task_group_members WHERE group_id = $1 AND settled = false`,
          [groupId],
        );
        for (const row of pending.rows as Array<{ job_id: string }>) {
          const jobId = row.job_id;
          // cancel（等待/延迟中的不再执行）后经 getJobById 核实真实生效才落定——
          // pg-boss 对不可取消状态静默 no-op，落定前核实防与运行实例的落定竞态重复计数
          await b.cancel(group.task, jobId);
          const job = await b.getJobById(group.task, jobId);
          if (job !== null && job.state === 'cancelled') {
            await this.settle(groupId, jobId, 'cancelled');
          }
        }
        const after = await this.get(groupId);
        return after!;
      },
    };
  }

  async function ensureBoss(): Promise<PgBoss> {
    if (boss) return boss;
    if (!bossStarting) {
      const starting = (async () => {
        const b = new PgBoss(options);
        // pg-boss 把连接池错误（PG 重启/网络闪断）与 worker 异常 emit 为 'error' 事件，
        // EventEmitter 无监听器时 emit 即抛 uncaughtException 崩进程——必须挂监听
        b.on('error', (err: unknown) => {
          console.error(
            '[faapi] pg-boss error:',
            err instanceof Error ? (err.stack ?? err.message) : err,
          );
        });
        // pg-boss 惰性连接：start 后才连库；驱动在首次 enqueue/startWorker 前建立。
        // start 完成前实例不外借——pre-open 的 executeSql 静默 no-op（返回 undefined），
        // 建连中并发调用会在半启动实例上跑 SQL
        await b.start();
        if (stopped) {
          // 停机竞态：start 期间 stop() 已执行——不回写实例（否则泄漏一个已 start、
          // 永不 stop 的 PgBoss），关闭后让调用方拿到失败
          await b.stop().catch(() => {});
          throw new Error('[faapi] Task queue is stopped and no longer accepts jobs');
        }
        boss = b;
        return b;
      })();
      bossStarting = starting;
      // start 失败清空 in-flight：下次调用重新建连（坏实例不入缓存）；
      // 身份校验防止误清 stop() 之后新建的 promise
      void starting.catch(() => {
        if (bossStarting === starting) bossStarting = null;
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
      // pg-boss 以 job 的 expire_in 硬限 handler 执行（DDL 默认 15 分钟）：超时判失败
      // 重试，而任务还在后台跑 → 同一任务两份并发执行。按任务元信息给足执行预算：
      // timeoutMs + graceMs + 缓冲；未声明 timeoutMs 的任务用 defaultExpireSeconds 兜底
      const expireInSeconds = opts?.timeoutMs
        ? Math.ceil((opts.timeoutMs + (opts.graceMs ?? DEFAULT_GRACE_MS)) / 1000) +
          EXPIRE_BUFFER_SECONDS
        : (defaultExpireSeconds ?? DEFAULT_EXPIRE_SECONDS);
      const sendOptions: SendOptions = {
        retryLimit: opts?.retries ?? 0,
        retryDelay: 1, // 秒；配合 retryBackoff 指数退避
        retryBackoff: true,
        expireInSeconds,
        ...(opts?.dedupId ? { id: dedupIdToUuid(opts.dedupId) } : {}),
        ...(opts?.delayMs ? { startAfter: new Date(Date.now() + opts.delayMs) } : {}),
      };
      // pg-boss data 形参为 object——基础类型 payload（cron 空任务等）按 JSON 语义透传；
      // 组投递成员以载荷包装携带组标识（交付时还原，业务 payload 不变）
      const id = await b.send(
        name,
        opts?.groupId !== undefined ? wrapGroupPayload(opts.groupId, payload) : (payload as object),
        sendOptions,
      );
      const jobId = id ?? (opts?.dedupId ? dedupIdToUuid(opts.dedupId) : null);
      if (!jobId) {
        // 无 dedupId 的失败投递才是异常（dedupId 幂等命中已在上方还原确定性 id）
        throw new Error(`[faapi] pg-boss send failed for task "${name}"`);
      }
      // 组投递成员登记（成员表行 = 落定记账的幂等守卫载体；幂等命中时
      // ON CONFLICT DO NOTHING——重复投递不重复登记）
      if (opts?.groupId !== undefined) {
        await ensureGroupTables(b);
        await b.getDb().executeSql(
          `INSERT INTO faapi_task_group_members (group_id, job_id)
           VALUES ($1, $2) ON CONFLICT (group_id, job_id) DO NOTHING`,
          [opts.groupId, jobId],
        );
      }
      return jobId;
    },

    async startWorker(name, workerOpts) {
      const b = await ensureBoss();
      await ensureQueue(b, name);
      const process: TaskDriverProcess = workerOpts.process;
      // 二次注册（reload 场景）先 offWork 旧 worker（v12 签名 offWork(name, { id })）
      const existing = workerIds.get(name);
      if (existing) {
        await b.offWork(name, { id: existing });
      }
      const workerId = await b.work<unknown>(
        name,
        { batchSize: workerOpts.concurrency, includeMetadata: true },
        async (jobs) => {
          // 批内并发执行 + 逐任务结算：complete/fail 按单 job id 调用（pg-boss 的结算
          // SQL 带 state 守卫——complete 仅 active、fail 仅 state<completed，handler
          // 正常返回后 onFetch 的批量 complete 对已结算任务是 no-op）。单个任务失败只
          // 消耗自己的重试额度，不毒化同批其他任务；concurrency 语义与 BullMQ 驱动一致
          await Promise.all(
            jobs.map(async (job) => {
              // retryCount 从 0 起（首次执行为 0）→ faapi attempt 从 1 起
              const attempt = job.retryCount + 1;
              // 组投递成员：从载荷包装还原业务 payload 与组标识（语义层据此记账）
              const { payload, groupId } = unwrapGroupPayload(job.data);
              // 信号由驱动自管：stop 超时 abort（pg-boss 自身不提供执行中任务的取消能力）
              const controller = new AbortController();
              inflight.set(job.id, controller);
              try {
                try {
                  await process({
                    id: job.id,
                    name,
                    payload,
                    attempt,
                    signal: controller.signal,
                    ...(groupId !== undefined ? { groupId } : {}),
                  });
                } catch (err) {
                  // fail 的 data 存 jsonb：传可序列化的错误摘要（原始 Error 序列化为 {} 丢信息）
                  const reason =
                    err instanceof Error
                      ? { name: err.name, message: err.message }
                      : { value: String(err) };
                  try {
                    await b.fail(name, job.id, reason);
                  } catch (failErr) {
                    // fail 结算失败：任务留在 active，由 pg-boss 的 expire_in 兜底结算
                    console.error(
                      `[faapi] pg-boss fail() failed for job ${job.id} of "${name}":`,
                      failErr,
                    );
                  }
                  return;
                }
                try {
                  await b.complete(name, job.id);
                } catch (completeErr) {
                  // complete 结算失败：任务留在 active，由 expire_in 兜底（不标失败——
                  // 任务已成功执行，标失败会触发重试导致重复执行）
                  console.error(
                    `[faapi] pg-boss complete() failed for job ${job.id} of "${name}":`,
                    completeErr,
                  );
                }
              } finally {
                inflight.delete(job.id);
              }
            }),
          );
        },
      );
      workerIds.set(name, workerId);
    },

    async stop(timeoutMs = 10_000) {
      stopped = true;
      const b = boss;
      bossStarting = null; // 停机后 ensureBoss 不再复用旧实例/旧建连 promise
      if (!b) return;

      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      let aborted = false;
      const deadline = new Promise<void>((resolve) => {
        deadlineTimer = setTimeout(() => {
          aborted = true;
          // deadline 到点 abort 在跑任务：监听 signal 的任务尽快退出；仍不退出的由
          // pg-boss 的 expire_in 兜底结算（resolveWithinSeconds 判超时失败并重试）
          for (const controller of inflight.values()) controller.abort();
          resolve();
        }, timeoutMs);
      });
      try {
        // offWork 等待在跑 handler 结束——卡死的任务会让它永久悬挂，必须与 deadline
        // 竞速保证 stop() 有界返回
        await Promise.race([
          (async () => {
            for (const [taskName, workerId] of workerIds.entries()) {
              await b.offWork(taskName, { id: workerId }).catch(() => {});
            }
          })(),
          deadline,
        ]);
        workerIds.clear();
        // graceful 收尾：pg-boss stop 的 timeout 单位是毫秒（其实现以 Date.now() 差值
        // 比较，超时 failWip 处置在跑任务）。整体与 deadline 竞速，超时即放弃等待
        await Promise.race([b.stop({ close: true, graceful: true, timeout: timeoutMs }), deadline]);
        boss = null;
      } finally {
        clearTimeout(deadlineTimer);
        if (!aborted) {
          for (const controller of inflight.values()) controller.abort();
        }
        inflight.clear();
      }
    },

    async stopWorkers() {
      const b = boss;
      if (b) {
        for (const [taskName, workerId] of workerIds.entries()) {
          await b.offWork(taskName, { id: workerId }).catch(() => {});
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

    async list(opts) {
      const b = await ensureBoss();
      // findJobs 按队列名查（无全局列出）：不传 name 遍历本进程已 ensureQueue 的
      // 任务名（与 BullMQ 驱动遍历已建 Queue 实例同语义）；FindJobsOptions 无
      // state/limit 过滤，映射后自行过滤 + 降序截断
      const targets = opts?.name ? [opts.name] : [...ensuredQueues];
      // pg-boss 六态 → faapi 六态精确映射（BullMQ 的 delayed 无法区分重试等待，
      // 只能归 pending；pg-boss 的 retry 态可精确区分）
      const stateMap: Record<string, TaskDriverRecord['status']> = {
        created: 'pending',
        retry: 'retry',
        active: 'running',
        completed: 'done',
        failed: 'failed',
        cancelled: 'cancelled',
      };
      const wanted = opts?.state ? [opts.state] : undefined;
      const records: TaskDriverRecord[] = [];
      for (const target of targets) {
        const jobs = await b.findJobs(target);
        for (const job of jobs) {
          const status = stateMap[job.state];
          if (!status) continue;
          if (wanted && !wanted.includes(status)) continue;
          // 组投递成员：从载荷包装还原业务 payload 与组标识（记录对业务不可见包装）
          const { payload, groupId } = unwrapGroupPayload(job.data);
          // fail 的 data 存 output jsonb：{ name, message } 或 { value }（startWorker
          // 结算形态）；错误摘要优先取 message/value——提取不到（空对象/缺失）时
          // 不放 error 字段，其余形态 String 化保底
          const output: unknown = (job as { output?: unknown }).output;
          let error: string | undefined;
          if (status === 'failed' && output !== undefined && output !== null) {
            if (typeof output === 'object') {
              const extracted =
                (output as { message?: unknown; value?: unknown }).message ??
                (output as { message?: unknown; value?: unknown }).value;
              error = extracted === undefined ? undefined : String(extracted);
            } else {
              error = String(output);
            }
          }
          records.push({
            id: job.id,
            name: job.name,
            payload,
            status,
            // retryCount 从 0 起（首次执行为 0）→ faapi attempts 从 1 起
            attempts: job.retryCount + 1,
            // 驱动 complete() 不携带执行结果（语义层自记），done 记录无 result
            createdAt: job.createdOn.getTime(),
            // startAfter 恒有值（send 未传时默认 now）——计划执行时间即本字段语义
            runAt: job.startAfter.getTime(),
            ...(groupId !== undefined ? { groupId } : {}),
            ...(error !== undefined ? { error } : {}),
          });
        }
      }
      return records.sort((a, b2) => b2.createdAt - a.createdAt).slice(0, opts?.limit ?? 50);
    },

    groups: createGroupOps(ensureBoss),
  };
}
