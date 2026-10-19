# taskSuspend（任务挂起/激活）

一句话概括：任务级挂起/激活原语——任务执行中 `taskCtx.suspend(state)` 暂存状态并释放执行体（任务记 `suspended`，不占 worker、不受 expire），任意入口 `tasks.resume(name, jobId, { inject? })` 激活重投原任务（state + inject 经执行上下文回传 `taskCtx.resumed`），支撑"等外部事件再继续"的长任务编排。

## 为什么需要

任务等待**队列外事件**（人工审批、HTTP 回调、外部系统返回）时，现有形态只有两条坏路：任务内 await 事件（执行体长驻内存、进程重启全丢、占 worker 并发额度），或业务手搓状态持久化 + 重投（state 存哪、重投怎么带状态、挂起观测/单飞/取消语义全部自管）。挂起/激活把这套收编为框架原语：执行体可死、状态不死（驱动侧持久化），观测面上"挂起中"可见、单飞互斥不重复起线、取消/激活语义有标准答案。

与既有原语的分工：**激活源在队列内**（子任务完成、fan-in）用链式任务 payload 流转（taskChain.md，state 随续投 payload 走）；**激活源在队列外**用本机制——队列不能"等一个事件"，suspended + resume 才是对应形态。两者不互相替代。

## 使用场景

```ts
// 1. 任务内挂起：暂存状态，执行体释放
export async function run(payload: Payload, taskCtx: TaskContext) {
  const result = await agent.run(payload.input, { messages: payload.resumeState });
  if (needsReview(result)) {
    // state 暂存驱动侧（跨实例/重启正确），本任务记 suspended，run 正常返回
    await taskCtx.suspend({ messages: result.messages, plan: extractPlan(result) });
    return;
  }
}

// 2. 激活：任意入口（HTTP handler / 回调 / 人工操作）同一 API
// POST /api/planner/:jobId/approve
export function POST(params: { jobId: string }, body: { comment: string }, tasks: TaskClient) {
  return tasks.resume('planner', params.jobId, { inject: { comment: body.comment } });
}

// 3. 续跑时从任务上下文取回暂存状态与激活注入
export async function run(payload: Payload, taskCtx: TaskContext) {
  taskCtx.resumed; // 首跑 undefined；激活时 { state, inject?, activations }
  const state = taskCtx.resumed?.state as { messages: LLMMessage[] } | undefined;
  await agent.run(taskCtx.resumed?.inject ? renderResume(taskCtx.resumed.inject) : payload.input, {
    messages: state?.messages,
  });
}
```

## 概念与语义

- **suspend(state?)**：两条执行路径均可用（`TaskContext.suspend` 进程内直调；`IsolatedTaskContext.suspend` 经 `{ type: 'suspend' }` 消息 RPC 回传宿主执行同一持久化，宿主走同一信封写入——语义零差；state 须可结构化克隆，不可克隆按执行错误处理，与 progress/log 同口径；驱动无 `taskState` 时宿主侧显式抛错、错误原样回传 worker）。调用后：state（连同原 payload）以信封形式持久化到驱动 `taskState` 存储、任务记录转 `suspended`、run 正常返回（驱动照常 complete 队列 job——语义层记录覆盖观测）。挂起后本任务的后续代码仍会执行到 return，但已完成挂起语义（结果不入 `result`、组记账不落定）。
- **suspended 状态**：非终态（还会被激活）也不在跑——`list()` / `listQueued()` 可见；内存护栏不淘汰（非终态）；**计入单飞活跃判定**（挂起的任务在等激活，同键不允许第二条起线——`enqueueChain` 活跃集为 pending/running/retry/suspended 四态）。
- **resume(name, jobId, opts?)**：仅对 suspended 任务生效（其他状态显式抛错）。读取信封（原 payload + state）→ 删除信封 → 以原 payload 重新入队（新执行周期：attempt 从 1 重新计数、usage 只算本次）→ 信封 `activations + 1` 随执行上下文回传。原挂起记录转 `done`（该挂起周期已终结），新执行为独立任务记录。
- **resumed 上下文**：`taskCtx.resumed = { state?, inject?, activations }`——`state` 为挂起时暂存值；`inject` 为本次激活传入的附加数据（审批意见等）；`activations` 为第几次激活（从 1 起）。经载荷包装随任务持久化传输（与组标识/链键同机制，跨实例正确），首跑为 `undefined`。
- **信封（TaskStateEntry）**：驱动存储的挂起载体 `{ jobId, task, payload, state?, suspendedAt, activations }`——payload 随信封持久化，resume 重投不依赖业务重放。**resume 读出即删**（state 转移到新执行；未激活的挂起信封保留供重启水合）。
- **取消/重试语义**：`cancel` 对 suspended 任务转 `cancelled` 并删除信封（挂起的线可人工掐死，驱动侧无活跃 job 可取消、跳过队列调用）；`retry` 对 suspended 任务显式抛错（语义不适用——激活用 resume）。
- **重启水合**：`queue.start()` 时从驱动 `taskState.list()` 重建 suspended 记录（含原 payload）——观测面跨重启闭环，激活不依赖记住重启前的进程。
- **组内挂起**：挂起不是落定（done/failed/cancelled 才是）——组员挂起时组记账不推进，激活后的执行真正完成时才落定。

## 能力边界（已声明语义，非降级）

- **驱动能力门槛**：suspend/resume 均依赖驱动可选能力 `TaskDriver.taskState`（`set` / `get` / `delete` / `list`，pgboss 一张表 / bullmq 一个 hash，与 groups 同模式）——未实现时显式抛错。`suspend()` 无 state 参数同样依赖（信封要携带原 payload 供 resume 重投，无参形态不可绕过）。
- **隔离路径克隆约束**：隔离执行的 `suspend` 经 postMessage RPC 回传宿主——`state` 须可结构化克隆（不可克隆按执行错误处理，与 progress/log 同口径）；挂起的 RPC 调用随任务超时两段式取消一并终止（与 `taskCtx.tasks` 调用同口径）。`resumed` 随 run 消息透传（信封为纯数据，天然可克隆），两路径读取方式一致。
- **激活竞态与跨实例**：resume 以信封读出即删承载互斥（两实例同时 resume 同一 jobId，驱动侧 get/delete 非原子——极小窗口双读，后果是重复入队一次激活执行，断点/幂等语义下有界）；同 fail-fast 不中断在跑成员同款的显式边界。activations 计数在信封内递增，跨实例正确。
- **挂起时长无上限**：suspended 不受 expire 约束（无在跑执行），也不参与重试——挂起多久由激活方决定，框架不做超时激活（需要超时语义时业务用 cron 定时查挂起任务自行激活）。

## 驱动映射（TaskDriver.taskState 可选能力）

| 驱动 | 存储 |
|------|------|
| `@faapi/task-pgboss` | 同库一张表 `faapi_task_states`（`job_id` PK + `task` / `payload` jsonb / `state` jsonb / `suspended_at` / `activations`，首次挂起操作时 `CREATE TABLE IF NOT EXISTS`） |
| `@faapi/task-bullmq` | 一个 Redis hash `<prefix>:task-states`（jobId → 信封 JSON，经 `Queue.client` 复用连接） |

`resumeState` 执行上下文传输：`TaskDriver.enqueue` 新增可选 `opts.resumeState`——驱动以载荷包装携带（`__faapiResume`，与 `__faapiGroup` / `__faapiChain` 同机制），交付时还原为 `TaskDriverJob.resumeState`，语义层据此构造 `taskCtx.resumed`。包装对业务不可见。

## 相关模块

- `src/task/taskQueue.ts` — suspend/resume 门面 + 信封读写 + 重启水合 + runJob 挂起落账（消费方；隔离路径 `onSuspend` 与进程内 `suspend` 共用同一信封写入）
- `src/task/taskWorker.ts` / `src/task/workerEntry.ts` — 隔离路径 suspend RPC 桥（`{ type: 'suspend' }` 消息 + seq 回传）与 `resumed` 透传
- `src/task/taskTypes.ts` — TaskContext.suspend / resumed / TaskClient.resume / TaskJobStatus.suspended
- `src/task/driverTypes.ts` — TaskDriver.taskState 可选能力 / enqueue opts.resumeState / TaskDriverJob.resumeState
- `packages/task-pgboss` / `packages/task-bullmq` — 信封存储 + 包装还原
- `src/task/taskChain.md` — 队列内激活源的姊妹原语（payload 流转），分工见上
