import path from 'node:path';
import { APP_EVENT } from '../events/appEventBus';
import { ValidationError } from '../errors/httpErrors';
import { createTaskToolContext } from './taskToolContext';
import { TaskCancelledError } from './taskTypes';
import { createEmptyTaskRegistriesView } from '../injection/registries';
import { createLogger } from '../loggers/logger';
import type { TaskDriver, TaskDriverJob, TaskResumeState, TaskStateEntry } from './driverTypes';
import type {
  TaskClient,
  TaskContext,
  TaskEvent,
  TaskGroupOnFailure,
  TaskGroupOutcome,
  TaskGroupSnapshot,
  TaskGroupSummary,
  TaskJob,
  TaskJobStatus,
  TaskModule,
  TaskQueue,
  TaskQueueDeps,
} from './taskTypes';

/** 终态（内存护栏的计数范围）：pending/running/retry 永不淘汰 */
const TERMINAL_STATUSES: ReadonlySet<TaskJobStatus> = new Set(['done', 'failed', 'cancelled']);

/**
 * 批量成员 dedupId 前缀与完成回调 dedupId 后缀（批量投递幂等键由框架独占管理，
 * 形状见 taskBatch.md——键名沿用组记账历史 `faapi-group:` 前缀）
 */
const GROUP_MEMBER_DEDUP = (groupId: string, index: number): string =>
  `faapi-group:${groupId}:${index}`;
const GROUP_COMPLETION_DEDUP = (groupId: string): string => `faapi-group:${groupId}:complete`;

/**
 * 终态记录内存上限：`list()` 为进程内观测快照而非持久化历史，长驻进程的
 * done/failed/cancelled 记录超限时按最旧优先淘汰（更早的历史由驱动侧视图
 * `listQueued` 承担——驱动实现 `TaskDriver.list` 时）
 */
const MAX_FINISHED_RECORDS = 1_000;

/**
 * 任务事件两级保留上限（taskEvents.md）：单执行缓冲超限丢最旧；全局超限按 job
 * 首次发射序整体淘汰最旧执行的事件缓冲（seq 计数器保留不回退）。事件生命周期
 * 与任务记录绑定（记录淘汰时事件一并清理）。
 */
const MAX_EVENTS_PER_JOB = 1_000;
const MAX_EVENTS_TOTAL = 10_000;

/**
 * 挂起信封持久化（suspend/resume 两路径共用的唯一写入点）
 *
 * 进程内 `taskCtx.suspend` 直调、隔离路径 `onSuspend`（worker RPC 回传宿主）
 * 共用：state 连同原 payload 以信封持久化到驱动 `taskState` 存储（跨实例/重启
 * 正确），调用方各自落 `suspended` 标记（完成分支据此转 suspended——不记 result、
 * 组记账不落定）。驱动未实现 `TaskDriver.taskState` 显式抛错（能力边界，两路径
 * 同口径——隔离路径错误经 RPC 原样回传 worker）。activations 保留进入本次执行时
 * 的值（首挂 0；激活重投的执行再挂时保留原计数，resume 时递增）
 */
async function persistSuspendEnvelope(
  driver: TaskDriver,
  job: TaskDriverJob,
  state?: unknown,
): Promise<void> {
  if (!driver.taskState) {
    throw new Error(
      '[faapi] Task driver does not support suspend/resume (TaskDriver.taskState is not implemented). ' +
        'Suspend/resume requires a driver that persists the state envelope — see taskSuspend.md / driverTypes.md.',
    );
  }
  const entry: TaskStateEntry = {
    jobId: job.id,
    task: job.name,
    payload: job.payload,
    state,
    suspendedAt: Date.now(),
    activations: job.resumeState?.activations ?? 0,
  };
  await driver.taskState.set(job.id, entry);
}

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
  /** 任务事件缓冲（jobId → seq 升序事件；生命周期与任务记录绑定） */
  const events = new Map<string, TaskEvent[]>();
  /** 事件 seq 计数（jobId → 已发射数；跨 attempt 连续，独立于缓冲存活——缓冲被
   * 全局上限整体淘汰后 seq 不回退） */
  const eventSeq = new Map<string, number>();
  /** 事件订阅者（任务名 → handler 集合；进程内存，随队列实例销毁） */
  const subscribers = new Map<string, Set<(event: TaskEvent) => void>>();
  /** 全局事件条数（淘汰护栏计数器） */
  let totalEvents = 0;

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
        // 事件生命周期与任务记录绑定：记录淘汰时事件缓冲与 seq 计数一并清理
        const buffer = events.get(id);
        if (buffer) {
          totalEvents -= buffer.length;
          events.delete(id);
        }
        eventSeq.delete(id);
      }
    }
  }

  /**
   * 事件落账（两条执行路径共用）：seq 递增 → 构造 TaskEvent 入缓冲（单执行上限
   * 丢最旧）→ 全局上限按 job 首次发射序整体淘汰 → 同步扇出订阅者（按任务名匹配；
   * handler 抛错 console.error 留痕——副作用回调不破坏任务执行，与 task:failed 事件同口径）。
   * 仅 running 状态调用（调用方守卫，与 progress 同口径）。
   */
  function appendEvent(record: TaskJob, data: unknown): void {
    const seq = (eventSeq.get(record.id) ?? 0) + 1;
    eventSeq.set(record.id, seq);
    const event: TaskEvent = {
      task: record.name,
      jobId: record.id,
      attempt: record.attempts,
      seq,
      at: Date.now(),
      data,
    };
    let buffer = events.get(record.id);
    if (!buffer) {
      buffer = [];
      events.set(record.id, buffer);
    }
    buffer.push(event);
    totalEvents++;
    if (buffer.length > MAX_EVENTS_PER_JOB) {
      buffer.shift();
      totalEvents--;
    }
    if (totalEvents > MAX_EVENTS_TOTAL) {
      // 按 job 首次发射序（Map 插入序）整体淘汰最旧执行的事件缓冲，seq 计数保留
      for (const [jobId, jobBuffer] of events) {
        if (totalEvents <= MAX_EVENTS_TOTAL) break;
        totalEvents -= jobBuffer.length;
        events.delete(jobId);
      }
    }
    const handlers = subscribers.get(record.name);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        handler(event);
      } catch (err) {
        console.error(
          `[faapi] task event subscriber threw for "${record.name}" (job ${record.id}):`,
          err,
        );
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

  /**
   * carry 纯数据校验（enqueue 时刻显式失败，与 config 快照同款边界）：身份/标记
   * 快照要随任务持久化（跨实例/重启）并 postMessage 进隔离 worker——非普通对象
   * 或含不可结构化克隆值（函数/symbol/不可克隆宿主对象）在入队即报错，不留到
   * 派发时刻才炸
   */
  function assertCarryData(carry: Record<string, unknown>): void {
    if (typeof carry !== 'object' || carry === null || Array.isArray(carry)) {
      throw new Error(
        '[faapi] carry must be a plain object of execution context (e.g. { currentUserId }) — ' +
          'arrays/primitives are not valid carry payloads.',
      );
    }
    try {
      structuredClone(carry);
    } catch {
      throw new Error(
        '[faapi] carry must be structured-cloneable pure data (it persists with the job and ' +
          'functions, symbols and non-cloneable ' +
          'host objects are not allowed. See taskTypes.md (TaskContext.carry).',
      );
    }
  }

  function assertGroupSupport(): void {
    if (!driver.groups) {
      throw new Error(
        '[faapi] Task driver does not support group accounting (TaskDriver.groups is not implemented). ' +
          'Batch enqueue/settle requires a driver that implements it — see driverTypes.md / taskBatch.md.',
      );
    }
  }

  /**
   * fan-in：批量全部落定且声明了 onComplete 而回调未入队时，入队完成回调任务
   * （TaskGroupSummary 契约 payload + dedup 兜底至多一份），成功后标记
   * completionEnqueued。入队失败 console.error 留痕（批量计数已落定、可经同 id
   * 幂等重投自愈）——记账失败不改成员执行语义，但不静默。
   * 供落定接线与 enqueueSequence/enqueueBatch 幂等重投自愈两条路径共用（重投时
   * 新批量 settled=0 自然短路，零开销）。
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
        `[faapi] task batch "${snap.groupId}" completion enqueue failed (batch is settled; ` +
          're-invoke enqueueSequence/enqueueBatch with the same id to re-arm the callback):',
        err,
      );
    }
  }

  /**
   * 批量成员落定接线：成员到达最终终态（done；failed/cancelled 且重试额度已尽）
   * 时驱动侧记账 + fan-in 判定 + 串行激活。fail-fast 成员最终失败即终止——串行
   * 序列（execution='serial'）不再激活、未激活成员经 settleRemaining 按计数差值
   * 补齐 cancelled；并行批次（execution='parallel'）经 cancelRemaining 取消队列中
   * 未落定成员；终止后快照同样过 fan-in 判定。串行序列落定即激活：驱动 settle 在
   * 记账同一原子操作内推进激活指针，真推进时返回下一条成员，语义层入队（成员
   * dedupId 按 index 幂等——重复激活/多实例竞态自动命中不重复执行；严格顺序由
   * willRetry 不落定守卫保证——重试耗尽才推进）。
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
        // 终止：serial 未激活成员补齐落定 / parallel 取消队列中未落定成员
        const after =
          snap.execution === 'serial'
            ? await driver.groups.settleRemaining(groupId, 'cancelled')
            : await driver.groups.cancelRemaining(groupId);
        await maybeFireCompletion(after);
        return;
      }
      if (snap.next) {
        // 落定即激活下一条（serial）：dedupId 按 index 幂等（重放/多实例竞态命中
        // 既有任务），激活入队失败（如队列已停）由外层 catch 留痕——序列停摆经同
        // sequenceId 重投自愈（taskBatch.md「记账语义」）
        await enqueueCore(snap.task, snap.next.payload, {
          dedupId: GROUP_MEMBER_DEDUP(groupId, snap.next.index + 1),
          groupId,
          groupIndex: snap.next.index,
          ...(snap.next.carry !== undefined ? { carry: snap.next.carry } : {}),
        });
      }
      await maybeFireCompletion(snap);
    } catch (err) {
      console.error(
        `[faapi] task batch accounting failed for "${groupId}" (job ${record.id}, ` +
          `outcome ${outcome}):`,
        err,
      );
    }
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
   * （任务在进程内执行；卡住时框架只能不再等待——停机 abort 由驱动 signal 承担）
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
    if (job.groupIndex !== undefined) record.groupIndex = job.groupIndex;
    if (job.carry !== undefined) record.carry = job.carry;
    record.attempts = job.attempt;
    transitionStatus(record, 'running');
    // 派发清空上一轮的进度（本轮执行经 taskCtx.progress 重新写入）
    delete record.progress;
    record.error = undefined;
    records.set(job.id, record);

    // willRetry 按任务 meta.retries 推算——failed/cancelled 但驱动还会重试时不算落定
    const willRetry = job.attempt <= (meta.retries ?? 0);

    // 挂起标记：taskCtx.suspend 被调用后置位——run 正常返回时按 suspended 落账
    // （不记 result、组记账不落定——挂起不是终态，激活后的执行完成时才落定）
    let suspended = false;

    try {
      let mod = moduleCache.get(job.name);
      if (!mod) {
        mod = await loadTaskModule(path.resolve(rootDir, meta.filePath));
        moduleCache.set(job.name, mod);
      }
      if (typeof mod.run !== 'function') {
        throw new Error(`Task "${job.name}" module has no run export`);
      }
      // 任务级能力先建局部变量：taskCtx 与 agent 执行 ctx 合成共用同一实例
      // （同一执行内的 tasks/log/signal 全链同源）
      const scopedTasks = createScopedTaskClient(job.id);
      const taskLog = createLogger(`task:${job.name}`, {
        fields: { jobId: job.id, task: job.name, attempt: job.attempt },
      });
      const taskCtx: TaskContext = {
        signal: job.signal,
        // 执行作用域客户端：委托队列本体（与 ctx.tasks / app.tasks 同一 app 实例），
        // 投递自动继承当前 carry
        tasks: scopedTasks,
        config: deps.config,
        job: { id: job.id, name: job.name, attempt: job.attempt },
        registries: registriesView,
        // 轻量补全通道惰性读取（插件晚于队列构造注册，执行时刻取值才可见）
        llm: deps.llm?.get(),
        // enqueue 时携带的执行上下文快照（未携带/旧格式任务为空对象）
        carry: job.carry ?? {},
        log: taskLog,
        progress: (value) => {
          if (record.status === 'running') record.progress = value;
        },
        // 事件出口：与本进程事件缓冲 + 订阅扇出同一落账通道（仅 running 采纳）
        emit: (data) => {
          if (record.status === 'running') appendEvent(record, data);
        },
        // 任务挂起：与隔离路径共用同一信封写入（persistSuspendEnvelope——语义
        // 零差），落账由完成分支按 suspended 标记执行。驱动未实现 taskState
        // 能力显式抛错（错误同步抛给 run，隔离路径经 RPC 原样回传）
        suspend: async (state?: unknown) => {
          await persistSuspendEnvelope(driver, job, state);
          suspended = true;
        },
        // 挂起/激活上下文：首跑 undefined；激活重投的执行经驱动载体还原回传
        ...(job.resumeState !== undefined ? { resumed: job.resumeState } : {}),
      };
      // taskCtx.agent 惰性通道（TaskContext 不声明该字段——类型由 @faapi/agent
      // declare module 增强为 AgentHandle）：首次访问经 agentHandle 工厂构造
      // （与 HTTP 请求链同一份 baseDeps），缓存复用；store 未注入/插件未注册工厂时
      // 为 undefined
      if (deps.agentHandle) {
        const store = deps.agentHandle;
        let cachedAgent: unknown;
        let agentResolved = false;
        Object.defineProperty(taskCtx, 'agent', {
          enumerable: true,
          get: () => {
            if (!agentResolved) {
              // 执行 ctx 按契约合成：carry 数据字段落顶层（身份在 enqueue 处
              // 声明一次）+ 契约字段（tasks/log/signal）后置——carry 不可覆盖
              // 框架保证。与隔离路径宿主侧执行器同配方（createTaskToolContext）
              cachedAgent = store.get(
                createTaskToolContext({
                  carry: taskCtx.carry,
                  tasks: scopedTasks,
                  log: taskLog,
                  signal: job.signal,
                }),
              );
              agentResolved = true;
            }
            return cachedAgent;
          },
        });
      }
      const result = await mod.run(job.payload, taskCtx);
      if (suspended) {
        // 挂起落账：非终态（内存护栏不淘汰、单飞活跃判定涵盖），不记 result、
        // 不落组账——驱动照常 complete 队列 job，语义层记录覆盖观测
        transitionStatus(record, 'suspended');
        return undefined;
      }
      transitionStatus(record, 'done');
      record.result = result;
      evictFinishedRecords();
      await settleGroup(record, 'done', willRetry);
      return result;
    } catch (err) {
      // 取消（执行被框架终止：停机取消——驱动 signal abort）与 run 自身失败分开记，
      // list() 可区分"任务被取消"与"任务出错"；两者都向上抛错交驱动按 retries 重试
      const cancelled = err instanceof TaskCancelledError || job.signal.aborted;
      const outcome: TaskGroupOutcome = cancelled ? 'cancelled' : 'failed';
      transitionStatus(record, outcome);
      record.error = err instanceof Error ? err.message : String(err);
      evictFinishedRecords();
      await settleGroup(record, outcome, willRetry);
      // task:failed 事件（观察类留痕口径）：
      // 告警/死信上报等副作用,订阅端抛错 console.error 留痕——不影响驱动重试决策,但不静默吞掉。
      // deps.appEvents 缺席（裸 createTaskQueue,无 app 编排）→ 不发射（能力边界,非降级）
      if (deps.appEvents) {
        const { appEvents } = deps;
        void Promise.resolve()
          .then(() =>
            appEvents.emit(APP_EVENT.taskFailed, {
              task: job.name,
              jobId: job.id,
              attempt: job.attempt,
              willRetry,
              cancelled,
              error: record.error!,
            }),
          )
          .catch((hookErr) => {
            console.error(`[faapi] task:failed subscriber threw for "${job.name}":`, hookErr);
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
   * 入队核心（queue.enqueue / enqueueSequence / enqueueBatch / fan-in 回调入队共用）：
   * 停止检查 → 存在性检查 → payload 校验 → 驱动入队 → 本地记录。
   * 供对象字面量定义前引用的辅助函数形式（queue 方法内部调用时 queue 已初始化）。
   */
  async function enqueueCore(
    name: string,
    payload: unknown,
    opts?: {
      delayMs?: number;
      dedupId?: string;
      groupId?: string;
      groupIndex?: number;
      resumeState?: TaskResumeState;
      carry?: Record<string, unknown>;
    },
  ): Promise<string> {
    if (stopped) {
      throw new Error('[faapi] Task queue is stopped and no longer accepts jobs');
    }
    assertKnownTask(name);
    if (opts?.carry !== undefined) assertCarryData(opts.carry);
    const data = await validatePayload(name, payload);
    const meta = registry.get(name)!;
    const id = await driver.enqueue(name, data, {
      delayMs: opts?.delayMs,
      retries: meta.retries ?? 0,
      dedupId: opts?.dedupId,
      ...(opts?.groupId !== undefined ? { groupId: opts.groupId } : {}),
      ...(opts?.groupIndex !== undefined ? { groupIndex: opts.groupIndex } : {}),
      ...(opts?.resumeState !== undefined ? { resumeState: opts.resumeState } : {}),
      ...(opts?.carry !== undefined ? { carry: opts.carry } : {}),
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
        ...(opts?.groupIndex !== undefined ? { groupIndex: opts.groupIndex } : {}),
        ...(opts?.carry !== undefined ? { carry: opts.carry } : {}),
        createdAt: Date.now(),
        ...(opts?.delayMs ? { runAt: Date.now() + opts.delayMs } : {}),
      });
    }
    return id;
  }

  /**
   * 持久化队列视图与本进程记录的合并快照（listQueued 门面与链式活跃查证共用）：
   * 驱动记录按 id 合并本进程观测（本进程优先——attempts/status/result/error 更实时）。
   * 驱动未实现 TaskDriver.list 显式抛错（与 listQueued 同口径，不降级）。
   */
  async function listQueuedRecords(name: string | undefined, limit: number): Promise<TaskJob[]> {
    if (!driver.list) {
      throw new Error(
        "[faapi] Task driver does not support listing queued tasks (TaskDriver.list is not implemented). Use the queue system's own management tools, or see driverTypes.md for per-driver capability.",
      );
    }
    const queued = await driver.list({ name, limit });
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
        ...(record.groupIndex !== undefined ? { groupIndex: record.groupIndex } : {}),
        ...(record.carry !== undefined ? { carry: record.carry } : {}),
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
  }

  /**
   * 任务执行作用域的 TaskClient 包装：enqueue 系方法自动继承当前执行的 carry
   * （显式传 carry 覆盖——身份在任务链上自然流转，Sidekiq Current / Temporal
   * headers 同款语义）。与队列本体的差异仅在这一项约定，其余方法直委托
   * （同一 app 实例队列语义不变）。
   */
  function createScopedTaskClient(_jobId: string): TaskClient {
    const inheritCarry = (): Record<string, unknown> | undefined => records.get(_jobId)?.carry;
    const withCarry = <O extends { carry?: Record<string, unknown> }>(opts?: O): O | undefined => {
      if (opts?.carry !== undefined) return opts;
      const inherited = inheritCarry();
      return inherited === undefined ? opts : ({ ...(opts ?? {}), carry: inherited } as O);
    };
    return {
      enqueue: (name, payload, opts) => queue.enqueue(name, payload, withCarry(opts)),
      list: (name) => queue.list(name),
      listQueued: (name) => queue.listQueued(name),
      cancel: (name, id) => queue.cancel(name, id),
      retry: (name, id) => queue.retry(name, id),
      enqueueSequence: (name, payloads, opts) =>
        queue.enqueueSequence(name, payloads, withCarry(opts)),
      enqueueBatch: (name, payloads, opts) => queue.enqueueBatch(name, payloads, withCarry(opts)),
      getGroup: (groupId) => queue.getGroup(groupId),
      resume: (name, jobId, opts) => queue.resume(name, jobId, opts),
      subscribe: (name, handler) => queue.subscribe(name, handler),
      listEvents: (name, opts) => queue.listEvents(name, opts),
    };
  }

  const queue: TaskQueue = {
    async enqueue(name, payload = {}, opts) {
      const id = await enqueueCore(name, payload, {
        delayMs: opts?.delayMs,
        dedupId: opts?.dedupId,
        ...(opts?.carry !== undefined ? { carry: opts.carry } : {}),
      });
      return { id };
    },

    async resume(name, jobId, opts) {
      if (stopped) {
        throw new Error('[faapi] Task queue is stopped and no longer accepts jobs');
      }
      assertKnownTask(name);
      if (!driver.taskState) {
        throw new Error(
          '[faapi] Task driver does not support suspend/resume (TaskDriver.taskState is not implemented). ' +
            'Suspend/resume requires a driver that persists the state envelope — see taskSuspend.md / driverTypes.md.',
        );
      }
      const record = records.get(jobId);
      if (!record || record.name !== name) {
        throw new Error(
          `[faapi] Task job "${jobId}" not found for task "${name}" — suspended jobs are listed via list()/listQueued().`,
        );
      }
      if (record.status !== 'suspended') {
        throw new Error(
          `[faapi] Task job "${jobId}" is not suspended (status: ${record.status}) — resume only applies to suspended jobs (activate with resume, see taskSuspend.md).`,
        );
      }
      const entry = await driver.taskState.get(jobId);
      if (!entry) {
        throw new Error(
          `[faapi] Suspended task "${jobId}" has no state envelope — the envelope is the source of truth for resume (original payload + suspended state). It may have been consumed by a concurrent resume or deleted.`,
        );
      }
      // 读出即删：state 转移到新执行（未激活的挂起信封保留供重启水合）
      await driver.taskState.delete(jobId);
      const id = await enqueueCore(name, entry.payload, {
        resumeState: {
          state: entry.state,
          ...(opts?.inject !== undefined ? { inject: opts.inject } : {}),
          activations: entry.activations + 1,
        },
        // 激活重投继承挂起前的 carry（执行身份随任务续存，不因挂起/激活丢失）
        ...(record.carry !== undefined ? { carry: record.carry } : {}),
      });
      // 原挂起记录转 done（该挂起周期已终结，新执行为独立任务记录）
      transitionStatus(record, 'done');
      evictFinishedRecords();
      return { id };
    },

    /**
     * 并行无序批量投递（taskBatch.md）：一次登记 N 个同构子任务并挂同一批量标识，
     * 全部成员立即入队并行执行。批量记账（成员行守卫 / unsettle 逆向 / fan-in）与
     * 串行序列共用，差异仅在激活策略——parallel 全量入队，无激活指针推进。
     */
    async enqueueBatch(name, payloads, opts) {
      if (stopped) {
        throw new Error('[faapi] Task queue is stopped and no longer accepts jobs');
      }
      assertGroupSupport();
      assertKnownTask(name);
      if (!Array.isArray(payloads) || payloads.length === 0) {
        throw new Error(
          '[faapi] enqueueBatch requires a non-empty payloads array — a batch without members can never settle.',
        );
      }
      const onComplete = opts?.onComplete;
      if (onComplete !== undefined) assertKnownTask(onComplete);
      const onFailure: TaskGroupOnFailure = opts?.onFailure ?? 'run-to-completion';
      // 全量校验前置：任一 payload 不合法整批不投递（部分投递的批量永不落定）
      const validated: unknown[] = [];
      for (const p of payloads) {
        validated.push(await validatePayload(name, p));
      }
      const batchId = opts?.batchId ?? crypto.randomUUID();
      await driver.groups!.create({
        id: batchId,
        task: name,
        total: validated.length,
        ...(onComplete !== undefined ? { onComplete } : {}),
        onFailure,
        mode: 'parallel',
      });
      const jobs: { id: string }[] = [];
      for (let i = 0; i < validated.length; i++) {
        // 成员 dedupId 框架独占派生（批量幂等键形状是批量语义的一部分）：
        // 同 batchId 幂等重投时已存在的成员直接命中不重复执行——发起任务
        // （batchId 从业务键派生）被驱动重试时重调 enqueueBatch 即天然补投自愈
        const id = await enqueueCore(name, validated[i]!, {
          delayMs: opts?.delayMs,
          dedupId: GROUP_MEMBER_DEDUP(batchId, i + 1),
          groupId: batchId,
          ...(opts?.carry !== undefined ? { carry: opts.carry } : {}),
        });
        jobs.push({ id });
      }
      // 自愈路径：批量已落定而回调未入队（宿主在落定与回调入队之间崩溃/失败）→ 补投；
      // 新批量 settled=0 自然短路
      await maybeFireCompletion((await driver.groups!.get(batchId))!);
      return { batchId, jobs };
    },

    /**
     * 串行有序批量投递（taskBatch.md）：一次登记 N 条已知 payload，前一条到达
     * 终态（含重试耗尽）才激活下一条。payloads/carry 随序列行持久化（激活发生在
     * 任意实例/重启之后），登记后仅入队首条，后续由 settleGroup 落定接线激活。
     * 首投与幂等重投走同一"确保推进"路径：入队 payloads[nextIndex]（dedupId 按
     * index 幂等——正常运行命中既有成员零开销，激活两步崩溃窗口真补投断链成员）。
     */
    async enqueueSequence(name, payloads, opts) {
      if (stopped) {
        throw new Error('[faapi] Task queue is stopped and no longer accepts jobs');
      }
      assertGroupSupport();
      assertKnownTask(name);
      if (!Array.isArray(payloads) || payloads.length === 0) {
        throw new Error(
          '[faapi] enqueueSequence requires a non-empty payloads array — a sequence without members can never settle.',
        );
      }
      const onComplete = opts?.onComplete;
      if (onComplete !== undefined) assertKnownTask(onComplete);
      const onFailure: TaskGroupOnFailure = opts?.onFailure ?? 'run-to-completion';
      if (opts?.carry !== undefined) assertCarryData(opts.carry);
      // 全量校验前置：任一 payload 不合法整序列不登记（清单须完整持久化）
      const validated: unknown[] = [];
      for (const p of payloads) {
        validated.push(await validatePayload(name, p));
      }
      const sequenceId = opts?.sequenceId ?? crypto.randomUUID();
      await driver.groups!.create({
        id: sequenceId,
        task: name,
        total: validated.length,
        ...(onComplete !== undefined ? { onComplete } : {}),
        onFailure,
        mode: 'serial',
        payloads: validated,
        ...(opts?.carry !== undefined ? { carry: opts.carry } : {}),
      });
      // 确保推进：入队 nextIndex 指向的成员（新序列为 0 = 首条；重投 dedup 命中或补投）
      const snap = (await driver.groups!.get(sequenceId))!;
      let id: string | undefined;
      if (snap.nextIndex !== undefined && snap.nextIndex < snap.total) {
        id = await enqueueCore(name, validated[snap.nextIndex]!, {
          ...(opts?.delayMs !== undefined && snap.nextIndex === 0 ? { delayMs: opts.delayMs } : {}),
          dedupId: GROUP_MEMBER_DEDUP(sequenceId, snap.nextIndex + 1),
          groupId: sequenceId,
          groupIndex: snap.nextIndex,
          ...(opts?.carry !== undefined ? { carry: opts.carry } : {}),
        });
      }
      // 自愈路径：序列已落定而回调未入队 → 补投；新序列 settled=0 自然短路
      await maybeFireCompletion((await driver.groups!.get(sequenceId))!);
      return { sequenceId, ...(id !== undefined ? { id } : {}) };
    },

    async getGroup(groupId) {
      assertGroupSupport();
      return driver.groups!.get(groupId);
    },

    subscribe(name: string, handler: (event: TaskEvent) => void): () => void {
      let handlers = subscribers.get(name);
      if (!handlers) {
        handlers = new Set();
        subscribers.set(name, handlers);
      }
      handlers.add(handler);
      return () => {
        const set = subscribers.get(name);
        if (!set) return;
        set.delete(handler);
        if (set.size === 0) subscribers.delete(name);
      };
    },

    listEvents(name: string, opts?: { jobId?: string }): TaskEvent[] {
      const result: TaskEvent[] = [];
      for (const [jobId, buffer] of events) {
        if (opts?.jobId !== undefined && jobId !== opts.jobId) continue;
        for (const event of buffer) {
          if (event.task !== name) continue;
          result.push(event);
        }
      }
      // 序：单执行内 seq 升序（缓冲序）；跨执行按 job 首次发射序（Map 迭代序）
      return result;
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
      return listQueuedRecords(name, 50);
    },

    async cancel(name: string, id: string): Promise<void> {
      if (!driver.cancel) {
        throw new Error(
          '[faapi] Task driver does not support cancelling tasks (TaskDriver.cancel is not implemented).',
        );
      }
      const record = records.get(id);
      // suspended 任务无活跃队列 job（执行体已释放、队列 job 已 complete）——
      // 挂起的线人工掐死：删信封 + 记录转 cancelled，不触达驱动取消
      if (record?.status === 'suspended') {
        if (driver.taskState) await driver.taskState.delete(id);
        transitionStatus(record, 'cancelled');
        evictFinishedRecords();
        return;
      }
      await driver.cancel(name, id);
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
      const suspendedRecord = records.get(id);
      if (suspendedRecord?.status === 'suspended') {
        throw new Error(
          `[faapi] Task job "${id}" is suspended — retry does not apply; activate it with resume() (see taskSuspend.md).`,
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
      // 重启水合：从驱动信封重建 suspended 记录（观测面跨重启闭环，激活不依赖
      // 记住重启前的进程）。幂等：已存在的记录不覆盖
      if (driver.taskState) {
        for (const entry of await driver.taskState.list()) {
          if (records.has(entry.jobId)) continue;
          records.set(entry.jobId, {
            id: entry.jobId,
            name: entry.task,
            payload: entry.payload,
            status: 'suspended',
            attempts: 0,
            createdAt: entry.suspendedAt,
          });
        }
      }
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
