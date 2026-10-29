# taskBatch（批量任务：串行有序 / 并行无序）

一句话概括：批量任务原语——`TaskClient.enqueueSequence`（串行有序）与 `TaskClient.enqueueBatch`（并行无序）一次登记 N 条已知 payload，框架承载清单持久化、记账与 fan-in；两者的差异仅在**激活策略**（逐条落定激活 vs 全量立即激活），存储与记账机制完全共用（序列行 = 组记账行，`execution` 字段区分形态）。

## 为什么需要

"一次登记 N 条"是任务系统的常见形态（批量导入、批量发送、分片处理），按条目之间的执行约束分两种场景：

1. **串行有序**——条目间有顺序依赖或下游限流（按序入库、逐章处理）：前一条到达终态（含重试耗尽）才激活下一条。业务手搓的样板：自续投链（段尾查断点续投下一段，断点对账是业务知识）、`remaining` 计数器、进度对账；
2. **并行无序**——条目相互独立、追求吞吐（批量发送、分片上传）：全部立即执行，只需记账与到齐回调。业务手搓的样板：自拼 dedupId+序号逐个 enqueue、自建 DAO 行累加"已完成几批"、fan-in 判定"到齐没有"（漏写静默失败）。

这些是**传输机制而非业务知识**（任何批量场景同构），收编为框架原语后业务只写"每条干什么"与"全部落定后干什么"。切分策略（按什么切、每批多大）是业务知识，不在框架范围。

## 使用场景

```ts
// 1. 串行有序：一次登记 10 条，前一条终态（含重试耗尽）才激活下一条
export function POST(body: { importId: number }, tasks: TaskClient) {
  return tasks.enqueueSequence('book-import-chunks', payloads10, {
    sequenceId: `import:${body.importId}`,  // 业务关联键（缺省自动生成）；重投自愈的幂等锚点
    onComplete: 'import-finished',          // 全部落定时框架自动入队的回调任务
    onFailure: 'fail-fast',                 // 可选：失败终止（缺省 run-to-completion 失败跳过继续）
  }); // → { sequenceId, id }——id 为首条成员任务 id（未激活成员未入队、无 id）
}

// 2. 并行无序：一次登记 10 条，全部立即执行
export function POST(body: { campaignId: number }, tasks: TaskClient) {
  return tasks.enqueueBatch('send-mail', payloads10, {
    batchId: `campaign:${body.campaignId}`,
    onComplete: 'campaign-finished',
    onFailure: 'fail-fast',                 // 可选：首个成员最终失败即取消余下（缺省跑完记 partial）
  }); // → { batchId, jobs: [{ id }, ...] }——全部成员立即入队
}

// 3. 完成回调任务（两形态同一契约）
// src/tasks/import-finished/task.ts
import type { TaskGroupSummary } from '@faapi/faapi';

export interface Payload extends TaskGroupSummary {}

export const task = { retries: 1 } satisfies FaapiTaskMeta;
export function run(payload: Payload) {
  // payload.done / payload.failed / payload.cancelled / payload.total
}

// 4. 记账查询（两形态同一快照通道，execution 区分形态）
const batch = await tasks.getGroup('campaign:5');
// → { groupId, task, total, done, failed, cancelled, settled, status,
//     execution: 'parallel' | 'serial', nextIndex?, completionEnqueued, ... }
```

## 概念与语义（两形态共用）

- **成员（member）**：批量内单个任务执行，复用单任务全部既有语义（payload zod 校验、meta retries/并发、隔离执行、事件管道）。
- **落定（settle）**：成员到达最终终态——`done` / `failed`（重试耗尽后）/ `cancelled`。失败但重试额度未尽（`willRetry`）不算落定，重试派发后继续流转。
- **完成回调（fan-in）**：全部成员落定时框架自动入队 `onComplete` 声明的任务，payload 为框架契约 `TaskGroupSummary`（回调任务 Payload 声明须兼容，建议 `interface Payload extends TaskGroupSummary {}`）。回调按任务名声明而非闭包——持久化、可重试、有独立 meta，停机重启不丢；入队 dedupId `faapi-group:<id>:complete` 兜底至多一份。
- **失败策略 `onFailure`**（二值，激活语义按形态适配）：
  - `'run-to-completion'`（**默认**）：成员最终失败不影响其余成员，回调照常在全部落定时触发，计数器如实记录（partial 由回调自行判断）。
  - `'fail-fast'`：首个成员**最终失败**即终止——串行序列不再激活后续条目（未激活成员补记 `cancelled`，经驱动 `settleRemaining` 按计数差值补齐）；并行批次取消队列中未落定成员（经驱动 `cancelRemaining`，在跑的自然跑完，实际取消成功的成员落定 `cancelled`）。回调仍由"全部落定"触发。
  - 手动 `tasks.cancel` 管理动作与 fail-fast 触发相互独立（只由成员失败触发；取消不引发级联取消）。
- **幂等重投自愈**：同 id（sequenceId/batchId）重复调用幂等——序列行 create 幂等（参数一致跳过 / 不一致抛错，payloads/carry 参与比对）；成员 dedupId 由框架独占派生（`faapi-group:<id>:<index>`，index 从 1 起），已存在的成员直接命中不重复执行。**长任务发起场景建议 id 从业务键派生**（如 `import:<taskId>`）——发起任务被驱动重试时重调即天然补投/自愈。串行序列的重投自愈额外覆盖"激活两步崩溃窗口"（见下）。
- **驱动能力门槛**：驱动未实现组记账（`TaskDriver.groups` 缺失）时两 API 显式抛错（不降级）。

### 串行有序专属语义（enqueueSequence）

- **激活（activation）**：登记后仅入队首条，后续在 `settleGroup` 落定接线内激活——驱动 `settle` 在记账同一原子操作内推进激活指针（`GREATEST(next_index, member_index+1)`），真推进时返回下一条 `{ index, payload }`，语义层入队（成员 dedupId 按 index 幂等——重复激活/多实例竞态自动命中不重复执行）。**严格顺序**：重试等待中（willRetry）不算落定、不激活——前一条重试耗尽到达终态才推进。
- **清单持久化**：payloads 全量校验后持久化到驱动侧序列行（激活发生在无调用栈上下文的任意实例/重启之后，清单必须框架承载）；`carry` 随序列声明持久化，每条激活入队时注入。
- **自愈窗口**：激活入队发生在驱动推进指针之后（同一 `settle` 调用返回、语义层入队两步）——进程在两步之间崩溃则序列停摆，同 sequenceId 重投自愈（入队 `payloads[nextIndex]`，dedupId 幂等，正常运行命中零开销）。
- **观测**：未激活成员不在队列中（`list`/`listQueued` 只见已激活成员），进度以 `getGroup` 为准（`nextIndex` = 指向下一个可能需要（重新）入队的成员 0 基 index；全部落定时 = total）。
- **fail-fast 补齐的记账特性**：`settleRemaining` 按计数差值补 `cancelled`（未激活成员无成员行），补齐后 `tasks.retry` 单个成员重跑再落定会使 `settled` 超过 `total`（cancelled 差值不可逆向撤回）——回调已入队（`completionEnqueued`）不会重复触发，计数失真仅限该管理场景。

### TaskClient 扩展

- `enqueueSequence(name, payloads, opts?)` → `{ sequenceId: string; id?: string }`
  - `id` 为首条成员任务 id；序列已落定的重投不再入队（无 `id`）。
  - `opts.sequenceId?`：缺省 `crypto.randomUUID()`。
  - `opts.onComplete?` / `opts.onFailure?` / `opts.delayMs?`（仅首条入队延迟——激活条由前一条落定时机决定）/ `opts.carry?`（随序列声明持久化）。
  - **全量校验前置**：payloads 逐个走既有 payload zod 校验，任一失败整序列不登记（`ValidationError`）；空数组抛错。
- `enqueueBatch(name, payloads, opts?)` → `{ batchId: string; jobs: { id: string }[] }`
  - 全部成员立即入队（返回各成员任务 id）。
  - `opts.batchId?`：缺省 `crypto.randomUUID()`。
  - `opts.onComplete?` / `opts.onFailure?` / `opts.delayMs?`（透传各成员）/ `opts.carry?`（每成员入队透传）。
  - **全量校验前置**与空数组抛错同上。

### 记账语义（准确性边界）

- **计数器精确**：驱动侧成员行（job 级 settled 标记 + outcome）保证落定记账**幂等**——同一成员重复落定不重复计数；`retry` 管理动作把已落定成员撤回 pending 时逆向记账（unsettle）。
- **跨实例正确**：记账状态在驱动存储（pg-boss 表 / Redis hash），任何实例执行的成员落定都写同一份；回调由"观察到全部落定"的实例入队，入队 dedupId 保证**回调任务至多一份**。
- **串行激活正确性不依赖指针**：重复激活/重放（如手动 retry 已落定成员重新执行再落定）由成员 dedupId 幂等兜底；指针（GREATEST 语义防回退）仅用于崩溃自愈时定位"下一个该补投谁"。
- **回调入队崩溃窗口**：回调入队发生在最后一个落定之后——进程在两步之间崩溃则回调丢失，重启后用同 id 重投自愈（幂等重投路径检查"已落定而回调未入队"则补投）。回调入队失败 `console.error` 留痕且 `completionEnqueued` 保持 false——可观测、可自愈，不静默。
- **组投递是 N 次驱动入队，非单事务**（parallel）——中途崩溃留下部分成员 + open 序列；同 id 重投自愈。
- **序列记录常驻驱动存储**（量级 = 批次数 × 成员数行）——框架不自动清理；pg-boss 侧随业务库迁移管理，BullMQ 侧为两组 Redis key，业务方按保留策略自行清理。
- **组进度口径**：框架只提供计数器进度（done/failed/cancelled/total）+ 串行激活指针（nextIndex）。业务自有进度指标是业务知识，留业务侧存储，经 sequenceId/batchId 关联。

## TaskContext.tasks（两条执行路径注入任务客户端）

`TaskContext.tasks` / `IsolatedTaskContext.tasks` 均为 `TaskClient`——批量登记不绕 `getApp()`（隔离 worker 内 `getApp()` 本就不可用）：

- **进程内路径**：活引用（与 `ctx.tasks` / `app.tasks` 同一 app 实例队列），enqueue 系方法自动继承当前执行的 carry。
- **隔离路径**：worker 内代理对象——全方法经 `{ type: 'tasks-call' }` 消息回传宿主执行（宿主走完整投递通道），结果/错误按 seq 回传；参数与返回值须可结构化克隆。挂起的调用随任务超时两段式取消一并终止，无独立超时。

## 驱动映射（TaskDriver.groups 可选能力）

批量记账是驱动**可选能力**：`TaskDriver.groups?: TaskDriverGroupOps` 整对象实现（create / settle / unsettle / markCompletionEnqueued / get / cancelRemaining / settleRemaining），未实现时 `enqueueSequence` / `enqueueBatch` / `getGroup` 显式抛错。两官方驱动均已实现：

| 驱动 | 存储 | 落定原子性 |
|------|------|-----------|
| `@faapi/task-pgboss` | 同库两张表 `faapi_task_groups` + `faapi_task_group_members`（`CREATE TABLE IF NOT EXISTS` + `ADD COLUMN IF NOT EXISTS` 幂等迁移，首次组操作时确保；存量行 DEFAULT 'parallel' 语义兼容） | 成员行 `UPDATE ... WHERE settled=false` 守卫幂等 + 组行计数递增 + serial 激活指针推进（`GREATEST`）+ 下一条 payload 读取，单条 CTE SQL 原子 |
| `@faapi/task-bullmq` | 两个 Redis hash：`<prefix>:group:<id>`（计数器+声明+mode/nextIndex/payloads/carry）+ `<prefix>:group-members:<id>`（jobId → 状态） | Lua 脚本（成员状态翻转 + HINCRBY 计数 + serial 指针推进 + next 解码原子；经 `Queue.client` 复用驱动连接，不加新连接） |

**成员携带组标识/序号的传输**：`TaskDriver.enqueue` 可选 `opts.groupId` / `opts.groupIndex`（serial 成员激活入队携带——成员行序号是 settle 推进指针的记账依据）——驱动以内部包装形态随任务载荷存储（`{ __faapiGroup, __faapiGroupIndex, __faapiPayload, ... }`，仅带元数据时包装），交付 work / findJobs 查询时还原为 `TaskDriverJob.groupId` / `groupIndex` + 原始 payload。包装对业务不可见、语义层零感知；保留键为框架命名空间，业务 payload 不应占用。

**fail-fast 分流**：parallel 组 → `cancelRemaining`（按成员行查未落定成员逐个取消，实际取消成功才落定——防与运行实例的落定竞态重复计数）；serial 序列 → `settleRemaining`（按计数差值补齐——未激活成员无队列任务可取消）。实现约束（两方法语义见 driverTypes.ts）：settle/unsettle 原子（单条 SQL / Lua）、记账持久化跨实例正确。

## 相关模块

- `src/tasks/taskQueue.ts` — enqueueSequence / enqueueBatch / getGroup 门面 + runJob 终态落定接线（消费方）
- `src/tasks/driverTypes.ts` — `TaskDriverGroupOps` 驱动能力接口（TaskDriverGroupCreate.mode / SettleResult.next / settleRemaining / cancelRemaining）
- `src/tasks/taskTypes.ts` — `TaskClient.enqueueSequence` / `enqueueBatch` / `TaskGroupSummary` / `TaskGroupSnapshot` / 两上下文 `tasks` 字段
- `src/tasks/taskWorker.ts` + `workerEntry.ts` — 隔离路径 tasks 代理 RPC（宿主 `onTasksCall`）
- `packages/task-pgboss` / `packages/task-bullmq` — 组记账驱动实现
