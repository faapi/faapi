# taskChain（链式任务：键控单飞 / 自续投）

一句话概括：链式任务原语——`TaskClient.enqueueChain(name, payload, { chainKey })` 按 chainKey 键控单飞（同键至多一条活跃任务），无活跃才入队（dedupId 框架托管、终态后可重投），供"长任务分段推进、段尾自续投下一段"的场景收编活跃查证 / 排除自身 / 幂等键管理三件编排样板。

## 为什么需要

长时 agent 调用（逐章拆书、批量蒸馏、分页爬取）单次任务跑不完，通用模式是**分段链**：任务体每段跑一段，段尾查业务断点，剩余未完自动续投下一段直到全部完成。扁平任务模型下三件样板全靠业务手搓：

1. **活跃查证**——续投 / 登记前 `listQueued` 拉快照、按业务键过滤 payload、判活跃态；工具侧（防重复登记）与任务侧（防链分叉）各写一份且细节不一致；
2. **排除自身**——任务体内自续投时活跃查证会查到自己（自身恒为 running），漏写 `j.id !== 当前job.id` 链续投被自身挡住，任务跑一段就静默断链；
3. **dedupId 管理**——固定幂等键在任务终态后仍占坑（pgboss send 自定义 id 主键保留期内 DO NOTHING），续投被迫拼时间戳绕开，自洽性依赖驱动内部机制、换驱动要重新论证。

这三件是**传输机制而非业务知识**（任何分段链场景同构），收编为框架原语后业务只写"每段干什么""是否续投"（断点对账）与"下一段的 payload"。**分段粒度与断点事实源是业务知识，不在框架范围。**与任务组（taskGroups.md）正交：组是并行扇出 + fan-in，链是串行单飞 + 自续投，不互相替代。

## 使用场景

```ts
// 1. 登记入口（handler / 工具侧）：chainKey 相同的活跃任务存在则不投，返回现状
export function POST(body: { novelId: number }, tasks: TaskClient) {
  return tasks.enqueueChain('deconstruct', { novelId: body.novelId, input: '...' }, {
    chainKey: `deconstruct:${body.novelId}`, // 业务关联键（一书一条拆解线）
  });
  // → { enqueued: true, id } | { enqueued: false, jobId, status }
}

// 2. 任务体自续投（段尾）：taskCtx.tasks 自动排除自身 job，自身 running 不挡续投
export async function run(payload: Payload, taskCtx: TaskContext) {
  /* ...agent.stream 跑一段... */
  const remaining = await pendingChapterCount(db, payload.novelId); // 断点对账（业务知识）
  if (remaining > 0) {
    await taskCtx.tasks.enqueueChain('deconstruct', nextSegmentPayload(payload), {
      chainKey: `deconstruct:${payload.novelId}`,
    });
  } // 不续投 = 链自然终止；链完成判定是业务知识，框架无 fan-in
}
```

## 概念与语义

- **chainKey（链键）**：业务关联键（如 `deconstruct:<novelId>`），必填非空字符串。同键任务在驱动记录与本进程记录中可辨识（`TaskJob.chainKey`，`list()` / `listQueued()` 可见），活跃查证按键过滤，不依赖业务 payload 形状约定。
- **键控单飞**：同 chainKey 且处于活跃态（pending / running / retry）的任务存在时不投递，返回 `{ enqueued: false, jobId, status }`（活跃任务现状）；无活跃才入队，返回 `{ enqueued: true, id }`。
- **排除自身（自动）**：`TaskContext.tasks` / `IsolatedTaskContext.tasks`（两条任务执行路径）上的 `enqueueChain` 调用自动排除调用方自身 job——自身恒为 running 态，不排除则任务内自续投永不可能。进程内为 per-execution 包装客户端自动注入；隔离路径经宿主侧 RPC 分派注入。`ctx.tasks` / `app.tasks` / `tasks` 参数注入（非任务上下文）不排除任何任务。excludeJobId 也作为显式 opts 字段暴露（框架自动注入，一般无需手传）。
- **dedupId 框架托管**：入队幂等键自动派生 `faapi-chain:<chainKey>:<入队毫秒时间戳>`——时间戳后缀保证终态后可重投（不同次投递键不同，不被保留期占坑的固定键 DO NOTHING）；不开放自定义 dedupId（幂等键形状是链语义的一部分）。同毫秒内同键重复投递会命中同一任务（dedup 语义，至多一份）。
- **链的完成**：最后一跳不续投链即自然终止——框架不记账链身份、无 fan-in 回调；链是否完成是业务对账知识（如"断点计数为 0"）。链的观测 = 同 chainKey 的任务记录序列（`listQueued(name)` 后按 `chainKey` 过滤）。

### TaskClient 扩展

- `enqueueChain(name, payload, opts?)` → `{ enqueued: true; id: string } | { enqueued: false; jobId: string; status: TaskJobStatus }`
  - `opts.chainKey`：必填非空字符串，缺失 / 空白抛错。
  - `opts.delayMs?`：透传入队（与 enqueue 同语义）。
  - `opts.excludeJobId?`：活跃查证时跳过的 job id（任务上下文内框架自动注入为自身，一般无需手传）。
  - payload 走 enqueue 同一校验通道（存在性检查 + payload zod 校验）。
  - **驱动能力门槛**：活跃查证走 `TaskDriver.list` 通道（驱动未实现 list 时显式抛错，与 `listQueued` 同口径）。两内置驱动均已实现（pgboss v12 findJobs / bullmq getJobs）。
  - chainKey 经载荷包装随任务持久化（与组任务的 groupId 同一机制，`{ __faapiChain, __faapiPayload }`），交付 / 查询时还原为 `TaskDriverJob.chainKey` / `TaskDriverRecord.chainKey`——包装对业务不可见。

### 记账与原子性边界（已声明语义，非降级）

- **活跃查证是快照非事务**——查证与入队之间存在竞态窗口：两实例同键并发登记 / 续投可能双双通过查证各自入队（链分叉）。链式场景的调用方唯一性通常由单任务执行承载（concurrency 默认 1，上一段任务自身续投），窗口极小；即便分叉，断点事实源幂等（分段产出落库幂等）时双链各自推进到同一终点，后果有界。需要更强保证时业务侧用外部锁。
- **快照容量边界**——活跃查证拉取同任务名记录（limit 200，驱动侧按 createdAt 降序截断）：同任务名历史记录积压超限时，最旧的活跃任务可能不在快照内而漏判。链式场景建议配合队列侧保留策略清理终态记录；writer 现状手搓版（listQueued limit 50）同边界，框架版仅放宽容量。
- **登记防重同样适用**——工具 / handler 侧的"同键重复登记返回现状"与任务侧续投是同一个 API 的两种调用位置，防重语义一致（非任务上下文调用不排除任何任务：其他实例 / 上一段的活跃任务照常挡投递）。

## 相关模块

- `src/task/taskQueue.ts` — enqueueChain 门面 + 活跃查证（listQueued 合并通道复用）+ runJob 交付还原 + taskCtx.tasks 包装注入 excludeJobId（消费方）
- `src/task/taskTypes.ts` — TaskClient.enqueueChain 类型 / TaskJob.chainKey / 两上下文 tasks 字段
- `src/task/driverTypes.ts` — TaskDriver.enqueue opts.chainKey / TaskDriverJob.chainKey / TaskDriverRecord.chainKey
- `src/task/taskWorker.ts` + `workerEntry.ts` — 隔离路径 tasks RPC 代理（enqueueChain 方法 + 宿主侧注入）
- `packages/task-pgboss` / `packages/task-bullmq` — chainKey 载荷包装与记录还原
- `src/task/taskGroups.md` — 并行扇出原语（与链正交，组是 fan-in、链是自续投）
