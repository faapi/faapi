# taskGroups（任务组：扇出 / 记账 / fan-in）

一句话概括：任务组原语——一次投递 N 个同构子任务并挂同一组标识，框架记账组内落定进度，全部成员落定时自动入队约定的完成回调任务，失败语义（fail-fast / 跑完记 partial）由投递方按组声明。

## 为什么需要

长任务切批扇出（大文件分批入库 / 批量发送 / 分片处理）是任务系统的常见形态，但扁平单任务模型下三件编排样板全靠业务手搓：

1. **扇出投递**——业务自拼 dedupId+序号逐个 enqueue（任务内扇出还要绕 `getApp()` 全局单例拿任务客户端）；
2. **进度聚合**——业务自建 DAO 行累加"已完成几批"；
3. **fan-in 判定**——业务在子任务里比对"到齐没有"，漏写就静默失败（无框架兜底）。

这三件是**传输机制而非业务知识**（任何切批场景同构），收编为框架原语后业务只写"每批干什么"与"到齐后干什么"。**切分策略（按什么切、每批多大）是业务知识，不在框架范围。**

## 使用场景

```ts
// 1. 组投递（handler / 任务内 / lifecycle 均可——tasks 为 TaskClient）
export function POST(body: { importId: number }, tasks: TaskClient) {
  return tasks.enqueueGroup(
    'book-import-chunks',              // 成员任务名（同构子任务——一组一个任务名）
    batches,                           // unknown[]：逐成员 payload（全量校验通过才开始投递）
    {
      groupId: `import:${body.importId}`, // 业务关联键（缺省自动生成）；重投自愈的幂等锚点
      onComplete: 'import-finished',   // fan-in 回调任务名（全部落定时框架自动入队）
      onFailure: 'run-to-completion',  // 缺省：跑完记 partial；'fail-fast' = 首个成员最终失败即取消余下
    },
  ); // → { groupId, jobs: [{ id }, ...] }
}

// 2. 完成回调任务（普通任务，独立文件/meta/重试——不是闭包，停机重启不丢）
// src/tasks/import-finished/task.ts
import type { TaskGroupSummary } from '@faapi/faapi';

export interface Payload extends TaskGroupSummary {}

export const task = { retries: 1 } satisfies FaapiTaskMeta;
export function run(payload: Payload) {
  // payload.done / payload.failed / payload.cancelled / payload.total —— 到齐后干什么
}

// 3. 任务内扇出不再绕 getApp()：两条执行路径的 taskCtx.tasks 均为 TaskClient
export async function run(payload: Payload, taskCtx: TaskContext) {
  await taskCtx.tasks.enqueueGroup('chunks', payloads, { groupId: `job:${payload.taskId}` });
}

// 4. 记账查询（管理视图 / 完成回调后的对账）
const group = await tasks.getGroup('import:42');
// → { id, task, total, done, failed, cancelled, settled, status, completionEnqueued, ... }
```

## 概念与语义

- **成员（member）**：组内单个任务执行，复用单任务全部既有语义（payload zod 校验、meta retries/并发、取消、隔离执行、dedupId 幂等）。
- **落定（settle）**：成员到达最终终态——`done` / `failed`（重试耗尽后）/ `cancelled`。失败但重试额度未尽（`willRetry`）不算落定，重试派发后继续流转。
- **完成回调（fan-in）**：全部成员落定时框架自动入队 `onComplete` 声明的任务，payload 为框架契约 `TaskGroupSummary`（`TaskClient.enqueue` 同一校验通道——回调任务的 Payload 声明须兼容该形状，建议 `interface Payload extends TaskGroupSummary {}`）。回调按任务名声明而非闭包——持久化、可重试、有独立 meta，停机重启不丢。
- **失败策略 `onFailure`**：
  - `'run-to-completion'`（**默认**）：成员最终失败不影响其余成员，回调照常在全部落定时触发，计数器如实记录（partial 由回调自行判断）。
  - `'fail-fast'`：首个成员**最终失败**即取消组内未落定成员（等待/延迟中的不再执行；已在跑的自然跑完）；取消的成员记 `cancelled` 并同样落定。回调仍由"全部落定"触发。
  - 手动 `tasks.cancel` 管理动作与 fail-fast 触发相互独立（fail-fast 只由成员失败触发；取消不引发级联取消）。

### TaskClient 扩展

- `enqueueGroup(name, payloads, opts?)` → `{ groupId, jobs: [{ id }, ...] }`
  - `opts.groupId?`：缺省 `crypto.randomUUID()`。同 groupId 重复调用**幂等重投**——组记账 create 幂等（参数一致跳过 / 不一致抛错），成员 dedupId 自动派生 `faapi-group:<groupId>:<index>`（替代业务自拼序号；已存在的成员直接命中不重复执行）。**长任务扇出场景建议 groupId 从业务键派生**（如 `import:<taskId>`）——发起任务被驱动重试时重调 enqueueGroup 即天然补投/自愈。
  - `opts.onComplete?`：完成回调任务名；声明时校验任务已注册。
  - `opts.onFailure?`：失败策略（见上）。
  - `opts.delayMs?`：透传各成员。
  - **全量校验前置**：payloads 逐个走既有 payload zod 校验，任一失败整组不投递（`ValidationError`）；`payloads` 为空数组抛错（组无成员则 fan-in 永不触发，属业务错误）。
  - 驱动未实现组记账（`TaskDriver.groups` 缺失）时显式抛错（与 `listQueued` 同口径，不降级）。
  - 成员 dedupId 由框架独占管理（组投递不开放自定义 dedupId——幂等键形状是组语义的一部分）。
- `getGroup(groupId)` → `TaskGroupSnapshot | undefined`（不存在返回 `undefined`；驱动未实现组记账显式抛错）。

### TaskGroupSummary（完成回调 payload 契约）

| 字段 | 说明 |
|------|------|
| `groupId` | 组标识（业务关联键原样透传） |
| `task` | 成员任务名 |
| `total` | 成员总数 |
| `done` / `failed` / `cancelled` | 按最终终态分桶计数 |
| `settled` | 已落定数（done+failed+cancelled） |

`TaskGroupSnapshot` 额外含 `onComplete?` / `onFailure` / `status: 'open' | 'settled'` / `completionEnqueued`。

### 记账语义（准确性边界）

- **计数器精确**：驱动侧成员行（job 级 settled 标记 + outcome）保证落定记账**幂等**——同一成员重复落定（如手动 cancel 与 fail-fast 取消竞态）不重复计数；`retry` 管理动作把已落定成员撤回 pending 时逆向记账（unsettle）。
- **跨实例正确**：记账状态在驱动存储（pg-boss 表 / Redis hash），任何实例执行的成员落定都写同一份；回调由"观察到全部落定"的实例入队，入队 dedupId `faapi-group:<groupId>:complete` 保证**回调任务至多一份**。
- **组进度口径**：框架只提供计数器进度（done/failed/cancelled/total）。业务自有进度指标（如"已入库章数"）是业务知识，留业务侧存储，经 groupId 关联。
- **已声明边界（非降级，显式语义）**：
  - 回调入队发生在最后一个落定之后（同一进程内先后两步）——进程在两步之间崩溃则回调丢失，重启后用同 groupId 重投 enqueueGroup 自愈（幂等重投路径检查"组已落定而回调未入队"则补投）。回调入队失败（队列已停 / 回调任务消失 / payload 不兼容）`console.error` 留痕且 `completionEnqueued` 保持 false——可观测、可自愈，不静默。
  - 组投递是 N 次驱动入队，非单事务——中途崩溃留下部分成员 + open 组；同 groupId 重投自愈（剩余成员照常入队，组补齐落定）。
  - 组记录（组行 + 成员行）常驻驱动存储（量级 = 组数 × 成员数行）——框架不自动清理（自动删业务可能还要查的记账是静默丢数据）；pg-boss 侧随业务库迁移管理，BullMQ 侧为两组 Redis key（`<prefix>:group:<id>` / `<prefix>:group-members:<id>`），业务方按保留策略自行清理。
  - 回调仅一份但 `settled >= total` 的判定容忍竞态窗口内的极小概率重复触发——dedupId 兜底为至多一份。
  - fail-fast 取消不中断在跑成员（队列系统无中断执行中任务的能力，与单任务 `cancel` 同边界）。

## TaskContext.tasks（两条执行路径注入任务客户端）

`TaskContext.tasks: TaskClient` / `IsolatedTaskContext.tasks: TaskClient`——任务内扇出/查询不再绕 `getApp()`（隔离 worker 内 `getApp()` 本就不可用，全局访问器读的是从未水合的默认实例）：

- **进程内路径**：活引用（与 `ctx.tasks` / `app.tasks` 同一 app 实例队列）。
- **隔离路径**：worker 内代理对象——`taskCtx.tasks.*` 全方法经 `{ type: 'tasks-call' }` 消息回传宿主执行（宿主走完整 enqueue 通道：存在性检查 + payload 校验 + 驱动入队 + 本地记录），结果/错误按 seq 回传；参数与返回值须可结构化克隆（与 progress/log 同口径，不可克隆按执行错误处理）。挂起的调用随任务超时两段式取消一并终止，无独立超时。

## 驱动映射（TaskDriver.groups 可选能力）

组记账是驱动**可选能力**（与 list/cancel/retry 同模式）：`TaskDriver.groups?: TaskDriverGroupOps` 整对象实现（create / settle / unsettle / markCompletionEnqueued / get / cancelRemaining），未实现时 `enqueueGroup` / `getGroup` 显式抛错。两官方驱动均已实现：

| 驱动 | 存储 | 落定原子性 |
|------|------|-----------|
| `@faapi/task-pgboss` | 同库两张表 `faapi_task_groups` + `faapi_task_group_members`（`CREATE TABLE IF NOT EXISTS`，首次组操作时确保） | 成员行 `UPDATE ... WHERE settled=false` 守卫幂等 + 组行计数递增（executeSql） |
| `@faapi/task-bullmq` | 两个 Redis hash：`<prefix>:group:<id>`（计数器+声明）+ `<prefix>:group-members:<id>`（jobId→状态） | Lua 脚本（成员状态翻转 + HINCRBY 计数原子；经 `Queue.client` 复用驱动连接，不加新连接） |

**成员携带组标识的传输**：`TaskDriver.enqueue` 新增可选 `opts.groupId`——驱动以内部包装形态随任务载荷存储（`{ __faapiGroup, __faapiPayload }`，仅组任务包装；交付 work/findJobs 时还原为 `TaskDriverJob.groupId` + 原始 payload，`TaskDriverRecord` 同样还原）。包装对业务不可见、语义层零感知；非组任务不包装（存量行为不变）。payload 恰为该形状（两保留键 + 无其他键）的非组任务会被误解包——保留键为框架命名空间，业务 payload 不应占用（与 dedupId→UUID 映射同量级的实现约定）。

**cancelRemaining**：按组查未落定成员（成员行），逐个取消（pgboss `boss.cancel` + `getJobById` 核实生效；BullMQ 仅对 waiting/delayed 状态 `job.remove()`），实际取消成功的成员落定为 `cancelled`（幂等守卫防与运行实例的落定竞态重复计数），返回记账后快照。

## 相关模块

- `src/task/taskQueue.ts` — enqueueGroup / getGroup 门面 + runJob 终态落定接线（消费方）
- `src/task/driverTypes.ts` — `TaskDriverGroupOps` 驱动能力接口
- `src/task/taskTypes.ts` — `TaskGroupSummary` / `TaskGroupSnapshot` / TaskClient 扩展 / 两上下文 `tasks` 字段
- `src/task/taskWorker.ts` + `workerEntry.ts` — 隔离路径 tasks 代理 RPC（宿主 `onTasksCall`）
- `packages/task-pgboss` / `packages/task-bullmq` — 组记账驱动实现
