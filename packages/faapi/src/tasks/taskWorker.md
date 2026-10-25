# taskWorker

一句话概括：任务隔离执行器——把 `worker.ts` 声明的隔离任务放进独立 worker 线程执行，超时两段式取消（先发优雅取消信号、宽限未退出再 `terminate()` 硬杀），保证"判定超时 = 执行真正终止"。

## 为什么需要

Node 主线程无法强杀协程：进程内执行的任务一旦卡住（死循环、上游 hang），框架只能"不再等待"而无法终止它——控制侧记了失败、重试已投递，旧协程仍在后台跑（假取消）。`worker_threads` 的 `terminate()` 是 Node 唯一能硬终止执行的机制，把任务执行放进隔离线程后，超时取消才具备"实际生效"的保证。

## 使用场景

- 任务以 `worker.ts` 声明（`src/tasks/<name>/worker.ts`，meta `timeoutMs` 必填）→ 该任务的每次执行走本执行器（隔离执行）
- `task.ts` 声明的进程内任务不走本模块（零开销）；需要超时上限保护的快速任务也应留在 `task.ts`（进程内 deadline 自行 `Promise.race`）
- 收尾时间不够 5s 默认宽限的任务（如等待长事务提交）用 `task.graceMs` 自行调大；不需要收尾的任务可设 `graceMs: 0`（判定取消即硬杀）：

```ts
// src/tasks/settle-payment/worker.ts
export const task = { timeoutMs: 60_000, graceMs: 15_000 };
export async function run(payload, taskCtx) {
  // 收尾耗时 > 5s 的任务：把清理逻辑挂在 taskCtx.signal 上，
  // 取消时在 15s 宽限期内完成事务提交/回滚，避免被 terminate 砍在半路
  taskCtx.signal.addEventListener('abort', () => rollbackTx());
  ...
}
```

## 使用场景中的写法

```ts
// src/tasks/slow-report/worker.ts
export const task = { timeoutMs: 60_000 };
export function run(payload, taskCtx) {
  // 配合取消：上游调用携带 signal、长循环检查 signal.aborted，
  // 超时/停机时本任务在宽限期内自行退出，无需走到 terminate
  return fetch(url, { signal: taskCtx.signal });
}
```

隔离任务跑 agent 走 `taskCtx.agent` 的 **run-only 句柄**——单次 `agent-run` RPC 转发宿主，完整循环（LLM IO、工具执行、钩子、reminders、sub-agent 派发）在宿主执行，worker 侧不组装 Agent：

```ts
// src/tasks/log-analysis/worker.ts
export const task = { timeoutMs: 1_800_000 }; // 30 分钟；必须是数字字面量（含 1_800_000 下划线分隔），表达式如 30 * 60_000 不被扫描识别
export async function run(payload, taskCtx) {
  if (!taskCtx.agent) throw new Error('agent 通道不可用（@faapi/agent 插件未加载？）');
  // input 字符串 = user 消息直传；对象 = 富派发形态（宿主按 agent 声明的 Input schema 校验）
  const result = await taskCtx.agent.run(payload.input, { agent: 'log-analyzer' });
  return result.messages.at(-1)?.content;
}
```

前提是宿主侧已注册 agent 循环执行器（`@faapi/agent` 插件加载，`TaskQueueDeps.agentRunner`）——未注册时 `taskCtx.agent` 恒 undefined（能力不存在非降级）。进程内任务组装 `AgentDeps` 的手工装配示例见 [taskTypes.md](./taskTypes.md) 的「任务内组装 Agent」章节。

长任务可经 `taskCtx.progress(value)` 上报进度（可选能力，不调用零开销）：值经 postMessage 回传宿主（记入 `TaskJob.progress`，`list()` 可见），调用时机任意（循环内按批上报等）。值必须可结构化克隆，不可克隆按执行错误处理（显式失败，不静默丢弃）；取消判定后（宽限期内）到达的 progress 忽略，不改变终局。

过程事件同理：`taskCtx.emit(data)` 的值经 `{ type: 'event' }` 消息回传宿主 `onEvent` 回调（语义层落事件缓冲 + 订阅扇出，`TaskClient.subscribe/listEvents` 消费），克隆纪律与取消口径与 progress 一致——完整契约见 [taskEvents.md](./taskEvents.md)。

组装完整 `AgentDeps`（含 `resolveToolSchema`）的示例见 [taskTypes.md](./taskTypes.md) 的「任务内组装 Agent」章节。

## 行为约定

- 执行：每次 dispatch 新建一个 worker（真实入口文件 [workerEntry](./workerEntry.ts)：moduleUrl/resourcesDir 经 workerData 传入，任务模块在首次 run 消息时动态 import）；worker 模块图独立——天然加载最新产物，dev 热替换后无需 cache-bust
- 取消（两段式）：超时（`timeoutMs`）或外部信号（驱动停机 abort）触发——先向 worker 发 abort 信号（任务监听 `taskCtx.signal` 可优雅退出），宽限期（task meta `graceMs`，默认 `KILL_GRACE_MS` 即 5s）内未退出则 `worker.terminate()` 硬杀；宿主侧 Promise 以超时错误 reject。**宽限期判定即终局**：宿主 Promise 的失败在宽限期到点即返回，不因任务在宽限内自行完成而改变
- 预取消快速失败：`externalSignal` 在派发时已 aborted（驱动停机竞态）不创建 worker，直接以 `TaskCancelledError` 失败——不白白承担线程冷启动
- 超时判定即终局：宽限期内 worker 迟到的完成/错误一律忽略，不翻案
- 结果传导：worker 内 run 的返回值经 postMessage 结构化回传（必须可克隆，不可克隆视为执行错误）；`taskCtx.progress(value)` 的值经 `{ type: 'progress' }` 消息回传宿主 `onProgress` 回调（语义层记入 `TaskJob.progress`）；`taskCtx.emit(data)` 的值经 `{ type: 'event' }` 消息回传宿主 `onEvent` 回调（语义层落事件缓冲 + 订阅扇出；`running` 阶段才采纳，宽限期内到达不采纳）。**错误以 `{ name, message, stack, props }` 序列化回传**（`props` 为 Error 自定义可枚举属性，如业务错误类的 `code`/`statusCode`），宿主侧重建为 `Error` 并回填 name/stack/props——错误信息不再只剩 message。**class 身份不跨线程**：重建对象是 `Error` 实例而非原 Error 子类，`instanceof ValidationError` 等判断在宿主侧不成立，跨线程判错请用 `err.name` / `err.code`。**props 含不可克隆值时任务显式失败**（错误信息含原错误的 name/message 与「自定义属性不可结构化克隆」指引，业务侧将错误属性改为纯数据即可恢复）——错误保真与可传递性物理上不可兼得时，显式失败优于静默丢属性（宿主必须知道错误附带信息丢失了）。worker 顶层异常（如模块 import 失败）经 `error` 事件回传，消息反序列化失败经 `messageerror` 事件按执行错误处理，均由语义层记 `failed` 并交驱动重试。**所有取消路径（超时终止/外部取消/宽限内结束）reject `TaskCancelledError`**——语义层据此把任务记录记为 `cancelled`（区别于 run 自身失败的 `failed`）
- **上下文类型显式分开**：隔离任务的 run 第二参数标注 [`IsolatedTaskContext`](./taskTypes.md)——config 为**纯数据快照**（派发时刻投影，函数值不进快照、非函数不可克隆值派发显式报错，见 configSnapshot.md），registries/llm/log/progress/emit 的快照与克隆约束见差异表；进程内任务标注 `TaskContext`——config 必有（活引用全量，与 handler 同一对象同一类型）。两类型的完整差异表见 taskTypes.md
- `resourcesDir` 为产物 resources 目录绝对路径（纯字符串，经 workerData 传入）——**仅作读取根播种数据源，不进业务可见的 taskCtx**（该数据字段已删除），任务读 `src/resources/` 静态文件走免传参 `readResource`。**读取根在入口 bootstrap 播种（`globalThis[Symbol.for('faapi.resources.dir')]`，与 `utils/readResource.ts` 的 symbol key 字面量需一致）**：入口自身的语句先于对任务模块的动态 import 执行，"播种先于任务模块求值"由结构保证（任务模块顶层 top-level await 调用 readResource 必然读到已绑定的读取根）；读取根经 globalThis 而非模块状态承载——入口 bundle 与 index bundle 是两份代码副本，globalThis 是唯一跨副本共享面。免传参 `readResource` 与 agent `systemPromptFile` 在 worker 内自动可用
- `taskCtx.registries` 为注册表只读视图：宿主从 app 注册表生成 `TaskRegistriesSnapshot` 纯数据快照（agent 条目经 `toAgentSnapshotRecord` 投影为 `AgentSnapshotRecord`——reminders 整体剥离、工厂形态 systemPrompt 剥离，字符串人设保留，见 [taskTypes.md](./taskTypes.md)；tools 原样）随 postMessage 传入，worker 入口内重建视图——注册表对象含函数闭包不可跨线程，元数据本身可克隆。**快照语义**：视图反映派发时刻的注册表（每次 dispatch 重新生成），执行中途的 reload 变更不影响当次执行；`taskCtx.registries.agent.getAgentEntry(name)` 拿到的 `filePath` 为产物路径（元数据查询用）。**视图语义与宿主一致**：worker 内重建的查询方法（workerEntry 的 `buildRegistriesView`，真实模块可直接单测）与宿主 `createTaskRegistriesView` 的运行时行为对齐（同一份注册表数据下两边输出逐字段一致），由对照测试锚定（`taskWorker.test.ts`），宿主侧语义变更会同步暴露漂移
- `taskCtx.llm` 为轻量 LLM 补全通道（可选）：**纯转发代理**（`buildLlmProxy`）——`complete(input, options)` 经单次 `{ type: 'llm-complete', seq, input, options }` 消息回传宿主，宿主从 `AppRegistries.llm` 取派发时刻注册的通道执行（LLM IO 全在宿主——worker 不加载 `@faapi/agent`，与 agent 循环同一份 providers/重试引擎），以 `{ type: 'llm-result', seq, ok, value | error }` 回传；宿主拒绝时错误原样回传 reject。**克隆纪律**：input/options/返回值须可结构化克隆——`options.onFailure` 钩子为函数不可跨线程（本地显式拒绝，任务内 try/catch 自行实现失败副作用）；`options.signal` 不可克隆但支持——剥离后转发，任务内业务级取消经 `{ type: 'llm-abort', seq }` 回传宿主 abort 对应请求（宿主侧 AbortController 由执行器注入 options.signal；与任务取消是两回事，任务取消不传播宿主，挂起的调用随两段式取消一并终止）。宿主 llm 通道未注册时 run 消息不带 `llmChannel`，worker 内 `taskCtx.llm` 为 `undefined`（能力不存在，非降级）。使用语义见 `@faapi/agent` 的 lightComplete.md
- **`taskCtx.agent` run-only 句柄（agent 循环收敛宿主）**：宿主注入 `onAgentRun` 回调（`TaskQueueDeps.agentRunner` 已注册时，语义层注入 `(request) => agentRunner.runAgent(agentHostCtx, request)`）时，run 消息携带 `agentChannel: true`，worker 入口挂载 run-only 句柄（workerEntry 的 `buildAgentRunProxy`，不动态加载 `@faapi/agent`）。`taskCtx.agent.run(input, options)` 经**单次 `{ type: 'agent-run', seq, agentName, input, options }` 消息**回传宿主——宿主以任务合成契约 ctx（`createTaskToolContext` 配方，carry 身份落顶层）构造 Agent 跑**完整编排循环**（LLM IO、工具执行、beforeToolCall/afterToolCall 钩子、reminders 渲染、sub-agent 派发全在宿主），以 `{ type: 'agent-run-result', seq, ok, value | error }` 回传；`ok: false` → worker 侧 reject → 任务以该错误失败。与 tasks-call 同口径：RPC 调用随任务超时两段式取消一并终止，running/grace 两阶段都处理。**输入双形态**：字符串 = user 消息直传；对象 = 富派发形态（宿主 `runAgent` 按 agent 声明的 Input schema 校验，失败抛 `AgentError` 浮出为任务错误）。**克隆纪律**：input/options/循环结果须可结构化克隆——宿主回传值不可克隆按执行错误回传（ReactLoopResult 须为纯数据）；provider 实例不可跨线程，`options.provider` 在 worker 侧被前置拒绝（`buildAgentRunProxy` 校验：`options.agent` 必填、provider 实例拒绝、不可克隆报错）。**取消语义（显式设计决策，维护者确认）**：任务取消（超时 / 停机 abort）只在 worker 侧生效——两段式取消不向宿主传播，宿主已开始的 agent-run 循环不感知取消、继续执行到自然结束，其结果随 worker 终止被丢弃（迟到的 agent-run-result 无接收方）；取舍：避免跨线程 signal 接线的复杂度，代价是取消后宿主侧 LLM tokens / 工具副作用会继续跑完当轮。插件未注册时 run 消息不带 `agentChannel`，worker 内 `taskCtx.agent` 恒 undefined（能力不存在非降级）
- `taskCtx.tasks` 为任务客户端代理（必有字段）：全方法经 `{ type: 'tasks-call' }` 消息回传宿主执行（`onTasksCall` 回调由语义层注入，闭包持有队列本体），结果/错误按 seq 匹配回传——宿主走完整 enqueue 通道（存在性检查 + payload 校验 + 驱动入队），与进程内路径零语义差。**参数与返回值须可结构化克隆**（不可克隆按执行错误处理，与 progress/log 同口径）；挂起的调用随任务超时两段式取消一并终止，无独立超时
- `taskCtx.suspend(state?)` 挂起（可选能力，与进程内 `TaskContext.suspend` 语义零差）：经 `{ type: 'suspend' }` 消息 RPC 回传宿主（`onSuspend` 回调由语义层注入，与进程内路径共用同一信封写入 `driver.taskState.set`），成功回 `{ type: 'suspend-result', seq, ok }`；宿主拒绝（驱动无 `taskState` 等）错误原样回传 reject。**state 须可结构化克隆**（不可克隆按执行错误处理）；挂起后 run 正常返回、宿主按 suspended 落账（不记 result、组记账不落定）；挂起的 RPC 调用随任务超时两段式取消一并终止。激活用 `tasks.resume`（state 经 `taskCtx.resumed` 回传——信封为纯数据，随 run 消息透传，首跑 `undefined`）。完整语义见 [taskSuspend.md](./taskSuspend.md)
- `taskCtx.config` 为派发时刻的配置纯数据快照：语义层每次 dispatch 调 `collectConfigSnapshot` 投影（函数值不进快照——lifecycle 钩子/`task.onFailed`/log sink/middlewares 等宿主行为面不跨线程；其余值 `structuredClone` 保真；含非函数不可克隆值派发即显式报错列路径）——与 registries 快照同款边界与快照语义，读数据字段（端口/驱动选项/llms/业务自定义段）不再需要 payload 手工搬运。见 [configSnapshot.md](./configSnapshot.md)
- 返回值必须可结构化克隆（纯数据）；不可克隆视为执行错误
- `resourceLimits` 内存上限（可选）：task meta `maxOldGenerationSizeMb`（数字字面量，MB）透传给 Node Worker 的 `resourceLimits.maxOldGenerationSizeMb`——声明后 worker 堆超过该值即被 V8 终止（`ERR_WORKER_OUT_OF_MEMORY` 经 `error` 事件 reject，任务记 `failed` 交驱动按 `retries` 重试），内存失控显式失败而非拖慢整机。未声明不传 resourceLimits（Node 默认堆上限，行为不变）。执行器只透传不校验——值的提取与下限校验在 scanTasks 构建期（见 scanTasks.md）

## 边界取舍（文档必须显眼）

- **状态隔离**：任务文件的模块级变量每次执行都是新实例——run 内依赖的连接池/缓存需自建，不与进程内共享
- **硬杀副作用**：terminate 可能把事务/写操作砍在半路，由业务方幂等自担（与队列 at-least-once 语义一致）
- **冷启动开销**：worker 创建 + 模块加载为每次执行的固定成本，仅隔离任务（`worker.ts`）承担；**冷启动计入 `timeoutMs` 计时**（超时从派发起算而非 run 开始）。**`timeoutMs` 上下限**（`scanTasks` 在 dev/build 启动期校验，越界直接报错不钳制）：**最小 60s**——声明超时的语义是"这是需要真取消的长任务"，一分钟内跑完的任务没必要隔离，改回 `task.ts` 走进程内执行即可（需要 deadline 进程内自行 `Promise.race`）；**最大 23h**——pg-boss 驱动按 timeoutMs 给 expire_in 预算而 pg-boss 12.28 前断言 expire_in 严格小于 24h，23h 上限兼容全部 pg-boss 12 小版本并保持跨驱动统一预算口径，为预算留约 1h 余量（需要更长执行预算拆可恢复的分段流水线，或改用 bullmq 驱动，Redis 无此上限）

## 相关模块

- `src/tasks/taskQueue.ts` — 语义层按 `meta.mode`（`worker.ts` → isolated）路由到本执行器；派发前先获得全局 worker 并发席位（见 [isolatedWorkerBudget.md](./isolatedWorkerBudget.md)）
- `src/tasks/driverTypes.ts` — externalSignal 来源（驱动停机 abort）
