# taskEvents（任务事件：taskCtx.emit / 宿主侧订阅与查询）

一句话概括：任务级过程事件原语——任务执行中经 `taskCtx.emit(data)` 发射业务事件（agent 流式 chunk、阶段标记等），宿主侧有界保留并支持实时订阅（`TaskClient.subscribe`）与查询（`TaskClient.listEvents`），两条执行路径（进程内 / 隔离 worker）口径一致。

## 为什么需要

任务内组装跑 agent（长产线跑几十分钟、几十轮 LLM 调用）时过程对管理面是黑盒：

- 对话内派发有框架级链路——`agent.stream` 冒泡 `deltaReasoning`/`toolCall`/`subagentDelta`，业务消费后广播成对话流水；
- 任务侧没有对等出口——`taskCtx.progress(value)` 是**单值覆盖槽**（派发清空、终态忽略、`list()` 只见最新值），不是事件流也不可订阅；`TaskClient.list/listQueued` 只回任务记录快照，无事件历史、无流式订阅。

业务要展示任务过程只能各自手搓 transport（worker→宿主克隆纪律、取消/重试时的事件口径、有界缓冲），每家一遍必然漂移。事件是**传输机制而非业务知识**（事件数据本身才是业务知识），收编为框架原语后业务只管发射与消费。

## 使用场景

```ts
// 1. 任务内发射事件（与 progress 并存：progress 记"当前进度单值"，emit 记"过程历史"）
export async function run(payload: Payload, taskCtx: TaskContext) {
  const handle = taskCtx.registries.agent /* 组装 Agent，略 */;

  // agent 事件不隐身：agent.stream 的 chunk 原样 emit 即成管道（框架不设专用 API——
  // 主包对 @faapi/agent 保持解耦，消费端本就要按 chunk 字段做业务分发）
  const stream = handle.stream(payload.input, { agent: 'distiller', model: 'gpt-4o' });
  for await (const chunk of stream) {
    taskCtx.emit?.({ kind: 'agent-chunk', chunk });
    // 终态后（含取消判定后）调用被忽略，无需业务自行守卫
  }
  return result;
}

// 2. 宿主侧实时订阅（管理面 / 对话 hub 桥接——本进程实时，不回放历史）
const unsubscribe = tasks.subscribe('skill-distill', (event) => {
  // event: { task, jobId, attempt, seq, at, data }
  hub.publish(event.data);
});

// 3. 查询事件历史（回放 / 管理端点——有界保留，事件随任务记录生命周期）
const events = tasks.listEvents('skill-distill', { jobId }); // seq 升序
```

## API 契约

### taskCtx.emit（两条执行路径同签名）

`TaskContext.emit? / IsolatedTaskContext.emit?: (data: unknown) => void`

- `data` 形状是业务知识，框架不规定、不校验（不参与 payload zod 通道）。
- **仅 `running` 状态生效，终态后调用被忽略**（与 progress 同口径，调用方无需自行守卫）。
- **隔离路径**：值经 `{ type: 'event' }` 消息 postMessage 回传宿主——**值须可结构化克隆**，不可克隆按执行错误处理（与 progress/log 同口径，显式失败不静默丢事件）；取消判定后（宽限期内）到达的事件宿主不采纳（超时判定即终局，与 progress/log 同口径）。
- 可选字段（与 progress/log/llm 同模式）：直接构造 TaskContext 的测试/自定义执行器可不传；业务侧经 `taskCtx.emit?.(x)` 调用。

### TaskClient 扩展（宿主侧观测面）

- `subscribe(name, handler)` → 退订函数
  - 本进程实时订阅：该任务名后续每次 emit 落账后**同步**回调（匹配所有执行/所有 attempt；handler 须快速返回，不做异步等待——同步扇出无背压）。
  - **不回放订阅前历史**（补历史用 `listEvents`；UI 桥接用 seq 去重衔接两段）。
  - handler 抛错 `console.error` 留痕（副作用回调，与 onFailed 同口径）——不影响任务执行与其他订阅者。
  - **仅宿主侧可用**：隔离任务 `taskCtx.tasks.subscribe` 显式抛错（回调函数不可结构化克隆跨线程）；进程内任务 `taskCtx.tasks.subscribe` 可用（活引用），但订阅面向管理面/桥接，任务内自订阅无典型场景。
- `listEvents(name, opts?)` → `TaskEvent[]`（单执行内 seq 升序；跨执行按 job 首次发射序）
  - `opts.jobId?`：收窄到单次执行。
  - 本进程有界保留的历史查询，**驱动无关**（不进 TaskDriver——与组记账进驱动刻意对比：组记账要跨实例正确，事件是观测面）。

### TaskEvent（落账后的统一形态）

| 字段 | 说明 |
|------|------|
| `task` | 任务名 |
| `jobId` | 任务执行 id（TaskJob.id） |
| `attempt` | 第几次执行（含重试，从 1 起） |
| `seq` | 事件序号：单任务执行内从 1 起单调递增，**跨 attempt 连续**（重试不清零——事件是过程历史，与 progress「派发清空」的刻意差异） |
| `at` | 宿主侧落账时间戳（毫秒） |
| `data` | emit 入参原样透传 |

## 保留边界（有界内存，显式声明非降级）

- **本进程内存观测面**——不持久化、不跨实例、重启即失，对标 `list()` 既有口径（"本进程内存活记录，不含其他实例/重启前历史"）。多实例部署中事件在执行实例上；跨实例事件流属驱动级持久化能力，无场景不建（UI 桥接与任务同进程）。
- **生命周期与任务记录绑定**：任务记录被终态淘汰（`MAX_FINISHED_RECORDS`）时其事件一并清理。
- **两级上限**：单执行 `MAX_EVENTS_PER_JOB`（1000，超出丢最旧）；全局 `MAX_EVENTS_TOTAL`（10000，超出按 job 首次发射序整体淘汰最旧执行的事件缓冲——seq 计数器保留不回退，极端高流量下中间区间可能缺失但序仍单调）。
- 订阅者列表为进程内存，`app.close()` 随队列实例销毁。

## 取消 / 重试口径（对齐 progress）

- 终态后（done/failed/cancelled）调用忽略——进程内由 status 守卫，隔离路径取消判定后宿主不采纳。
- 重试不清事件：新 attempt 的事件追加进同一缓冲（`attempt` 字段标注、`seq` 连续），历史完整可回放——与 progress「派发清空上一轮」是两种语义（单值进度 vs 过程历史）。
- 停机取消（驱动 abort）：宽限期内到达的事件不采纳，与 progress/log 同口径。

## 相关模块

- `src/task/taskTypes.ts` — `TaskEvent` 类型、两上下文 `emit` 字段、TaskClient 扩展
- `src/task/taskQueue.ts` — 事件落账（appendEvent：缓冲 + 订阅扇出）、`TASK_CLIENT_METHODS` 白名单加 `listEvents`
- `src/task/taskWorker.ts` — 隔离管道 `{ type: 'event' }` 消息接线（`onEvent` 回调，grace 期丢弃）
- `src/task/workerEntry.ts` — worker 侧 `emit` 构造（不可克隆显式失败）、tasks 代理 `subscribe` 显式拒绝 / `listEvents` RPC 透传
