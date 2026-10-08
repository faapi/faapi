import path from 'node:path';
import { ValidationError } from '../errors/httpErrors';
import { runTaskInWorker, TaskCancelledError } from './taskWorker';
import { createEmptyTaskRegistriesView } from '../injection/registries';
import { createLogger, getEffectiveLogLevel, writeLogEntry } from '../logger/logger';
import type { AgentMetadata } from '../ast/extractAgentMetadata';
import type { TaskDriverJob } from './driverTypes';
import type {
  TaskContext,
  TaskGroupOnFailure,
  TaskGroupOutcome,
  TaskGroupSnapshot,
  TaskGroupSummary,
  TaskJob,
  TaskJobStatus,
  TaskModule,
  TaskQueue,
  TaskQueueDeps,
  TaskRegistriesSnapshot,
} from './taskTypes';

/** 终态（内存护栏的计数范围）：pending/running/retry 永不淘汰 */
const TERMINAL_STATUSES: ReadonlySet<TaskJobStatus> = new Set(['done', 'failed', 'cancelled']);

/**
 * 任务组成员 dedupId 前缀与完成回调 dedupId 后缀（组投递幂等键由框架独占管理，
 * 形状见 taskGroups.md——业务自拼序号扇出由本约定替代）
 */
const GROUP_MEMBER_DEDUP = (groupId: string, index: number): string =>
  `faapi-group:${groupId}:${index}`;
const GROUP_COMPLETION_DEDUP = (groupId: string): string => `faapi-group:${groupId}:complete`;

/** 隔离任务 taskCtx.tasks 代理允许回传宿主的方法（TaskClient 全集） */
const TASK_CLIENT_METHODS: ReadonlySet<string> = new Set([
  'enqueue',
  'enqueueGroup',
  'list',
  'listQueued',
  'cancel',
  'retry',
  'getGroup',
]);

/**
 * 终态记录内存上限：`list()` 为进程内观测快照而非持久化历史，长驻进程的
 * done/failed/cancelled 记录超限时按最旧优先淘汰（更早的历史由驱动侧视图
 * `listQueued` 承担——驱动实现 `TaskDriver.list` 时）
 */
const MAX_FINISHED_RECORDS = 1_000;

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

  /** 任务侧注册表只读视图（缺省空视图——直接构造队列的测试/嵌入场景） */
  const registriesView = deps.registries ?? createEmptyTaskRegistriesView();

  /** 任务记录（id → job；跨驱动一致的本地快照） */
  const records = new Map<string, TaskJob>();
  /** 任务模块缓存（name → module） */
  const moduleCache = new Map<string, TaskModule>();
  /** payload schema 缓存（name → schema 或 undefined 表示无 schema） */
  const schemaCache = new Map<string, unknown>();

  let started = false;
  let stopped = false;

  /** 终态记录数（done/failed/cancelled）——淘汰护栏的计数器 */
  let finishedCount = 0;

  /** 记录状态流转：维护终态计数（终态↔非终态迁移时增减），避免每次终态写入全量计数 */
  function transitionStatus(record: TaskJob, status: TaskJobStatus): void {
    const wasTerminal = TERMINAL_STATUSES.has(record.status);
    const nowTerminal = TERMINAL_STATUSES.has(status);
    if (!wasTerminal && nowTerminal) finishedCount++;
    else if (wasTerminal && !nowTerminal) finishedCount--;
    record.status = status;
  }

  /** 终态记录超上限按最旧优先淘汰（Map 迭代序 = 插入序；O(n) 单次扫描） */
  function evictFinishedRecords(): void {
    let toEvict = finishedCount - MAX_FINISHED_RECORDS;
    for (const [id, job] of records) {
      if (toEvict <= 0) break;
      if (TERMINAL_STATUSES.has(job.status)) {
        records.delete(id);
        finishedCount--;
        toEvict--;
      }
    }
  }

  const loadTaskModule =
    deps.loadTaskModule ?? (async (filePath: string) => (await import(filePath)) as TaskModule);

  const loadPayloadSchema =
    deps.loadPayloadSchema ??
    (async (filePath: string) => {
      const zodPath = path.join(path.dirname(filePath), 'zod.js');
      const mod = (await import(zodPath)) as Record<string, unknown>;
      const schemaKey = Object.keys(mod).find((k) => k.endsWith('Schema'));
      if (!schemaKey) {
        throw new Error(
          `[faapi] Task payload schema artifact has no *Schema export: ${zodPath} — ` +
            're-run "faapi dev" / "faapi build" to regenerate task artifacts.',
        );
      }
      return mod[schemaKey];
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

  function assertGroupSupport(): void {
    if (!driver.groups) {
      throw new Error(
        '[faapi] Task driver does not support group accounting (TaskDriver.groups is not implemented). ' +
          'Group enqueue/settle requires a driver that implements it — see driverTypes.md / taskGroups.md.',
      );
    }
  }

  /**
   * fan-in：组全部落定且声明了 onComplete 而回调未入队时，入队完成回调任务
   * （TaskGroupSummary 契约 payload + dedup 兜底至多一份），成功后标记
   * completionEnqueued。入队失败 console.error 留痕（组计数已落定、可经同
   * groupId 幂等重投自愈）——记账失败不改成员执行语义，但不静默。
   * 供落定接线与 enqueueGroup 幂等重投自愈两条路径共用（enqueueGroup 重投时
   * 新组 settled=0 自然短路，零开销）。
   */
  async function maybeFireCompletion(snap: TaskGroupSnapshot): Promise<void> {
    if (!driver.groups) return;
    if (!snap.onComplete || snap.completionEnqueued || snap.settled < snap.total) return;
    const summary: TaskGroupSummary = {
      groupId: snap.groupId,
      task: snap.task,
      total: snap.total,
      done: snap.done,
      failed: snap.failed,
      cancelled: snap.cancelled,
      settled: snap.settled,
    };
    try {
      await enqueueCore(snap.onComplete, summary, {
        dedupId: GROUP_COMPLETION_DEDUP(snap.groupId),
      });
      await driver.groups.markCompletionEnqueued(snap.groupId);
    } catch (err) {
      console.error(
        `[faapi] task group "${snap.groupId}" completion enqueue failed (group is settled; ` +
          're-invoke enqueueGroup with the same groupId to re-arm the callback):',
        err,
      );
    }
  }

  /**
   * 组内成员落定接线：成员到达最终终态（done；failed/cancelled 且重试额度已尽）
   * 时驱动侧记账 + fan-in 判定；fail-fast 组在成员最终失败时先取消余下成员
   * （实际取消成功的成员由驱动落定 cancelled，取消后快照同样过 fan-in 判定）。
   * 记账失败 console.error 留痕（成员执行语义已定，不因记账失败翻案，但不静默）。
   */
  async function settleGroup(
    record: TaskJob,
    outcome: TaskGroupOutcome,
    willRetry: boolean,
  ): Promise<void> {
    const groupId = record.groupId;
    if (!groupId || !driver.groups) return;
    if (outcome !== 'done' && willRetry) return; // 驱动还会重试——不算落定
    try {
      const snap = await driver.groups.settle(groupId, record.id, outcome);
      if (outcome === 'failed' && snap.onFailure === 'fail-fast') {
        await maybeFireCompletion(await driver.groups.cancelRemaining(groupId));
      }
      await maybeFireCompletion(snap);
    } catch (err) {
      console.error(
        `[faapi] task group accounting failed for "${groupId}" (job ${record.id}, ` +
          `outcome ${outcome}):`,
        err,
      );
    }
  }

  /**
   * 注册表纯数据快照（隔离路径 postMessage 用）——agent 取完整元数据
   * （getAgentEntry 含 filePath，非仅 LLM 可见字段），派发时刻生成
   */
  function snapshotRegistries(): TaskRegistriesSnapshot {
    return {
      agents: registriesView.agent
        .listAgents()
        .map((core) => registriesView.agent.getAgentEntry(core.name))
        .filter((entry): entry is AgentMetadata => entry !== undefined),
      tools: registriesView.tool.list(),
      skills: registriesView.skill.list(),
    };
  }

  async function validatePayload(name: string, payload: unknown): Promise<unknown> {
    if (!schemaCache.has(name)) {
      const meta = registry.get(name)!;
      // 加载失败（zod.js 缺失/损坏）向上抛错——构建期已强制 Payload 声明必填
      // （generateTaskArtifacts），运行时缺产物即产物不一致，不静默放行
      schemaCache.set(name, await loadPayloadSchema(path.resolve(rootDir, meta.filePath)));
    }
    const schema = schemaCache.get(name);
    if (!schema || typeof (schema as { safeParse?: unknown }).safeParse !== 'function') {
      throw new Error(
        `[faapi] Task "${name}" has no valid payload schema (zod.js missing or no *Schema export). ` +
          'Payload declarations are mandatory: re-run "faapi dev" / "faapi build" to regenerate task artifacts.',
      );
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
    if (job.groupId !== undefined) record.groupId = job.groupId;
    record.attempts = job.attempt;
    transitionStatus(record, 'running');
    // 派发清空上一轮的进度（本轮执行经 taskCtx.progress 重新写入）
    delete record.progress;
    record.error = undefined;
    records.set(job.id, record);

    // willRetry 按任务 meta.retries 推算——failed/cancelled 但驱动还会重试时不算落定
    const willRetry = job.attempt <= (meta.retries ?? 0);

    try {
      let result: unknown;
      if (meta.timeoutMs !== undefined && meta.timeoutMs > 0) {
        result = await (deps.runIsolated ?? runTaskInWorker)({
          taskModulePath: path.resolve(rootDir, meta.filePath),
          payload: job.payload,
          taskCtx: {
            // 隔离任务不传 config：worker 线程不接收进程配置（config 含函数字段
            // 不可结构化克隆，框架不做降级传递）——任务数据经 payload 显式传入
            resourcesDir: deps.resourcesDir,
            job: { id: job.id, name: job.name, attempt: job.attempt },
          },
          registries: snapshotRegistries(),
          // agent.llms 纯数据快照随 workerData 下发，worker 内动态加载 @faapi/agent
          // 重建轻量补全通道（taskCtx.llm）——llms 未配置时不传
          llms: deps.llms,
          // 日志配置随 workerData 下发（纯数据），worker 内联重建 taskCtx.log，
          // 条目回传宿主走统一管道（scope/fields 与进程内路径一致）
          log: {
            level: getEffectiveLogLevel(),
            scope: `task:${job.name}`,
            fields: { jobId: job.id, task: job.name, attempt: job.attempt },
          },
          timeoutMs: meta.timeoutMs,
          graceMs: meta.graceMs,
          externalSignal: job.signal,
          onProgress: (value) => {
            if (record.status === 'running') record.progress = value;
          },
          onLog: writeLogEntry,
          // 隔离路径的 taskCtx.tasks 为 postMessage RPC 代理——宿主侧按方法名
          // 分派到队列本体（与 ctx.tasks / app.tasks 同一实例），结果/错误按 seq 回传
          onTasksCall: async (method, args) => {
            if (!TASK_CLIENT_METHODS.has(method)) {
              throw new Error(`[faapi] Unknown task client method "${method}"`);
            }
            const fn = (queue as unknown as Record<string, (...a: unknown[]) => unknown>)[
              method
            ] as (...a: unknown[]) => unknown;
            return fn.apply(queue, args);
          },
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
          // 活引用：与 ctx.tasks / app.tasks 同一 app 实例队列
          tasks: queue,
          config: deps.config,
          job: { id: job.id, name: job.name, attempt: job.attempt },
          registries: registriesView,
          // 轻量补全通道惰性读取（插件晚于队列构造注册，执行时刻取值才可见）
          llm: deps.llm?.get(),
          log: createLogger(`task:${job.name}`, {
            fields: { jobId: job.id, task: job.name, attempt: job.attempt },
          }),
          progress: (value) => {
            if (record.status === 'running') record.progress = value;
          },
        };
        result = await mod.run(job.payload, taskCtx);
      }
      transitionStatus(record, 'done');
      record.result = result;
      evictFinishedRecords();
      await settleGroup(record, 'done', willRetry);
      return result;
    } catch (err) {
      // 取消（执行被框架终止：隔离执行超时终止 / 停机取消）与 run 自身失败分开记，
      // list() 可区分"任务被取消"与"任务出错"；两者都向上抛错交驱动按 retries 重试
      const cancelled = err instanceof TaskCancelledError || job.signal.aborted;
      const outcome: TaskGroupOutcome = cancelled ? 'cancelled' : 'failed';
      transitionStatus(record, outcome);
      record.error = err instanceof Error ? err.message : String(err);
      evictFinishedRecords();
      await settleGroup(record, outcome, willRetry);
      // onFailed 副作用钩子（告警/死信上报）：willRetry 按 meta.retries 推算，
      // 自身抛错 console.error 留痕——不影响驱动重试决策，但不静默吞掉
      if (deps.onFailed) {
        void Promise.resolve()
          .then(() =>
            deps.onFailed!({
              task: job.name,
              jobId: job.id,
              attempt: job.attempt,
              willRetry,
              cancelled,
              error: record.error!,
            }),
          )
          .catch((hookErr) => {
            console.error(`[faapi] task onFailed hook threw for "${job.name}":`, hookErr);
          });
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

  /**
   * 入队核心（queue.enqueue / enqueueGroup / fan-in 回调入队共用）：
   * 停止检查 → 存在性检查 → payload 校验 → 驱动入队 → 本地记录。
   * 供对象字面量定义前引用的辅助函数形式（queue 方法内部调用时 queue 已初始化）。
   */
  async function enqueueCore(
    name: string,
    payload: unknown,
    opts?: { delayMs?: number; dedupId?: string; groupId?: string },
  ): Promise<string> {
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
      // 执行硬限预算透传驱动（pgboss 映射 expireInSeconds）：未声明 timeoutMs 时
      // 两字段为 undefined，驱动用自身兜底
      timeoutMs: meta.timeoutMs,
      graceMs: meta.graceMs,
      ...(opts?.groupId !== undefined ? { groupId: opts.groupId } : {}),
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
        ...(opts?.groupId !== undefined ? { groupId: opts.groupId } : {}),
        createdAt: Date.now(),
        ...(opts?.delayMs ? { runAt: Date.now() + opts.delayMs } : {}),
      });
    }
    return id;
  }

  const queue: TaskQueue = {
    async enqueue(name, payload = {}, opts) {
      const id = await enqueueCore(name, payload, {
        delayMs: opts?.delayMs,
        dedupId: opts?.dedupId,
      });
      return { id };
    },

    async enqueueGroup(name, payloads, opts) {
      if (stopped) {
        throw new Error('[faapi] Task queue is stopped and no longer accepts jobs');
      }
      assertGroupSupport();
      assertKnownTask(name);
      if (!Array.isArray(payloads) || payloads.length === 0) {
        throw new Error(
          '[faapi] enqueueGroup requires a non-empty payloads array — a group without members can never settle.',
        );
      }
      const onComplete = opts?.onComplete;
      if (onComplete !== undefined) assertKnownTask(onComplete);
      const onFailure: TaskGroupOnFailure = opts?.onFailure ?? 'run-to-completion';
      // 全量校验前置：任一 payload 不合法整组不投递（部分投递的组永不落定）
      const validated: unknown[] = [];
      for (const p of payloads) {
        validated.push(await validatePayload(name, p));
      }
      const groupId = opts?.groupId ?? crypto.randomUUID();
      await driver.groups!.create({
        id: groupId,
        task: name,
        total: validated.length,
        ...(onComplete !== undefined ? { onComplete } : {}),
        onFailure,
      });
      const jobs: { id: string }[] = [];
      for (let i = 0; i < validated.length; i++) {
        // 成员 dedupId 框架独占派生（组幂等键形状是组语义的一部分）：
        // 同 groupId 幂等重投时已存在的成员直接命中不重复执行——发起任务
        // （groupId 从业务键派生）被驱动重试时重调 enqueueGroup 即天然补投自愈
        const id = await enqueueCore(name, validated[i]!, {
          delayMs: opts?.delayMs,
          dedupId: GROUP_MEMBER_DEDUP(groupId, i + 1),
          groupId,
        });
        jobs.push({ id });
      }
      // 自愈路径：组已落定而回调未入队（宿主在落定与回调入队之间崩溃/失败）→ 补投；
      // 新组 settled=0 自然短路
      await maybeFireCompletion((await driver.groups!.get(groupId))!);
      return { groupId, jobs };
    },

    async getGroup(groupId) {
      assertGroupSupport();
      return driver.groups!.get(groupId);
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
          ...(record.groupId !== undefined ? { groupId: record.groupId } : {}),
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
      if (record) {
        transitionStatus(record, 'cancelled');
        evictFinishedRecords();
        // 组内成员：管理取消即最终终态（无重试语义），照常落定 + fan-in 判定
        await settleGroup(record, 'cancelled', false);
      }
    },

    async retry(name: string, id: string): Promise<void> {
      if (!driver.retry) {
        throw new Error(
          '[faapi] Task driver does not support retrying tasks (TaskDriver.retry is not implemented).',
        );
      }
      await driver.retry(name, id);
      const record = records.get(id);
      if (record) {
        const wasTerminal = TERMINAL_STATUSES.has(record.status);
        transitionStatus(record, 'pending'); // 等待驱动重新派发
        // 组内成员撤回落定（计数回退），重新派发落定后重新记账
        if (wasTerminal && record.groupId && driver.groups) {
          await driver.groups.unsettle(record.groupId, record.id).catch((err) => {
            console.error(
              `[faapi] task group unsettle failed for "${record.groupId}" (job ${record.id}):`,
              err,
            );
          });
        }
      }
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
