# taskWorker

一句话概括：任务隔离执行器——把声明了 `timeoutMs` 的任务放进独立 worker 线程执行，超时两段式取消（先发优雅取消信号、宽限未退出再 `terminate()` 硬杀），保证"判定超时 = 执行真正终止"。

## 为什么需要

Node 主线程无法强杀协程：进程内执行的任务一旦卡住（死循环、上游 hang），框架只能"不再等待"而无法终止它——控制侧记了失败、重试已投递，旧协程仍在后台跑（假取消）。`worker_threads` 的 `terminate()` 是 Node 唯一能硬终止执行的机制，把任务执行放进隔离线程后，超时取消才具备"实际生效"的保证。

## 使用场景

- 任务声明 `task.timeoutMs`（`src/tasks/<name>/task.ts` 的 meta）→ 该任务的每次执行走本执行器（隔离执行）
- 未声明 `timeoutMs` 的任务不走本模块，仍为进程内执行（零开销）
- 收尾时间不够 5s 默认宽限的任务（如等待长事务提交）用 `task.graceMs` 自行调大；不需要收尾的任务可设 `graceMs: 0`（判定取消即硬杀）：

```ts
// src/tasks/settle-payment/task.ts
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
// src/tasks/slow-report/task.ts
export const task = { timeoutMs: 60_000 };
export function run(payload, taskCtx) {
  // 配合取消：上游调用携带 signal、长循环检查 signal.aborted，
  // 超时/停机时本任务在宽限期内自行退出，无需走到 terminate
  return fetch(url, { signal: taskCtx.signal });
}
```

隔离任务同样可访问 app 注册表（只读视图）——在 worker 线程内组装/调用 agent：

```ts
// src/tasks/log-analysis/task.ts
export const task = { timeoutMs: 1_800_000 }; // 30 分钟；必须是数字字面量（含 1_800_000 下划线分隔），表达式如 30 * 60_000 不被扫描识别
export async function run(payload, taskCtx) {
  const agent = taskCtx.registries.agent.getAgent('log-analyzer');
  if (!agent) throw new Error('agent not registered');
  // 组装 agent 跑 LLM 循环（agent 元数据含 systemPrompt/tools/model 等）
  return analyzeAll(payload, agent);
}
```

长任务可经 `taskCtx.progress(value)` 上报进度（可选能力，不调用零开销）：值经 postMessage 回传宿主（记入 `TaskJob.progress`，`list()` 可见），调用时机任意（循环内按批上报等）。值必须可结构化克隆，不可克隆按执行错误处理（显式失败，不静默丢弃）；取消判定后（宽限期内）到达的 progress 忽略，不改变终局。

组装完整 `AgentDeps`（含 `resolveToolSchema`）的示例见 [taskTypes.md](./taskTypes.md) 的「任务内组装 Agent」章节。

## 行为约定

- 执行：每次 dispatch 新建一个 worker（真实入口文件 [workerEntry](./workerEntry.ts)：moduleUrl/resourcesDir 经 workerData 传入，任务模块在首次 run 消息时动态 import）；worker 模块图独立——天然加载最新产物，dev 热替换后无需 cache-bust
- 取消（两段式）：超时（`timeoutMs`）或外部信号（驱动停机 abort）触发——先向 worker 发 abort 信号（任务监听 `taskCtx.signal` 可优雅退出），宽限期（task meta `graceMs`，默认 `KILL_GRACE_MS` 即 5s）内未退出则 `worker.terminate()` 硬杀；宿主侧 Promise 以超时错误 reject。**宽限期判定即终局**：宿主 Promise 的失败在宽限期到点即返回，不因任务在宽限内自行完成而改变
- 预取消快速失败：`externalSignal` 在派发时已 aborted（驱动停机竞态）不创建 worker，直接以 `TaskCancelledError` 失败——不白白承担线程冷启动
- 超时判定即终局：宽限期内 worker 迟到的完成/错误一律忽略，不翻案
- 结果传导：worker 内 run 的返回值经 postMessage 结构化回传（必须可克隆，不可克隆视为执行错误）；`taskCtx.progress(value)` 的值经 `{ type: 'progress' }` 消息回传宿主 `onProgress` 回调（语义层记入 `TaskJob.progress`）。**错误以 `{ name, message, stack, props }` 序列化回传**（`props` 为 Error 自定义可枚举属性，如业务错误类的 `code`/`statusCode`），宿主侧重建为 `Error` 并回填 name/stack/props——错误信息不再只剩 message。**class 身份不跨线程**：重建对象是 `Error` 实例而非原 Error 子类，`instanceof ValidationError` 等判断在宿主侧不成立，跨线程判错请用 `err.name` / `err.code`。**props 含不可克隆值时任务显式失败**（错误信息含原错误的 name/message 与「自定义属性不可结构化克隆」指引，业务侧将错误属性改为纯数据即可恢复）——错误保真与可传递性物理上不可兼得时，显式失败优于静默丢属性（宿主必须知道错误附带信息丢失了）。worker 顶层异常（如模块 import 失败）经 `error` 事件回传，消息反序列化失败经 `messageerror` 事件按执行错误处理，均由语义层记 `failed` 并交驱动重试。**所有取消路径（超时终止/外部取消/宽限内结束）reject `TaskCancelledError`**——语义层据此把任务记录记为 `cancelled`（区别于 run 自身失败的 `failed`）
- **隔离任务不传 config**：`ctx.config` 为 `undefined`——config 含函数字段（lifecycle 钩子等）不可结构化克隆，框架不做任何降级传递（不裁剪、不标记、不 JSON 快照）。进程内任务的 `ctx.config` 为活引用全量配置，与 handler `ctx.config` 同一对象同一类型（`FaapiContextConfig` 声明合并增强）。隔离任务需要的数据经 payload 显式传入（调用方 `tasks.enqueue('sync', { db: ctx.config.db })`），依赖显式出现在任务输入里；误访问 `ctx.config.db` 在 undefined 上取属性是响亮的 TypeError 指向代码行
- `resourcesDir` 为产物 resources 目录绝对路径（纯字符串，经 workerData 传入）——**仅作读取根播种数据源，不进业务可见的 taskCtx**（该数据字段已删除），任务读 `src/resources/` 静态文件走免传参 `readResource`。**读取根在入口 bootstrap 播种（`globalThis[Symbol.for('faapi.resources.dir')]`，与 `utils/readResource.ts` 的 symbol key 字面量需一致）**：入口自身的语句先于对任务模块的动态 import 执行，"播种先于任务模块求值"由结构保证（任务模块顶层 top-level await 调用 readResource 必然读到已绑定的读取根）；读取根经 globalThis 而非模块状态承载——入口 bundle 与 index bundle 是两份代码副本，globalThis 是唯一跨副本共享面。免传参 `readResource` 与 agent `systemPromptFile` 在 worker 内自动可用
- `taskCtx.registries` 为注册表只读视图：宿主从 app 注册表生成 `TaskRegistriesSnapshot` 纯数据快照（agents 含 `filePath` 完整元数据 + tools + skills）随 postMessage 传入，worker 入口内重建视图——注册表对象含函数闭包不可跨线程，元数据本身可克隆。**快照语义**：视图反映派发时刻的注册表（每次 dispatch 重新生成），执行中途的 reload/DB skill 变更不影响当次执行；`taskCtx.registries.agent.getAgentEntry(name)` 拿到的 `filePath` 为产物路径（元数据查询用）。**视图语义与宿主一致**：worker 内重建的查询方法（workerEntry 的 `buildRegistriesView`，真实模块可直接单测）与宿主 `createTaskRegistriesView` 的运行时行为对齐（同一份注册表数据下两边输出逐字段一致），由对照测试锚定（`taskWorker.test.ts`），宿主侧语义变更会同步暴露漂移
- `taskCtx.llm` 为轻量 LLM 补全通道（可选）：`agent.llms` 纯数据快照随 run 消息传入，worker 内动态加载 `@faapi/agent` 重建实例（`buildLlmChannel`，specifier 变量拼接避免主包静态依赖）。**llms 已配置但 `@faapi/agent` 不可解析（未安装 / 导出缺失）→ 显式抛错**（含安装指引），任务失败——配置声明了能力而环境不能交付属环境错误，fail fast 不静默旁路；llms 未配置时不触发加载、`taskCtx.llm` 为 `undefined`（能力不存在，非降级）。使用语义见 `@faapi/agent` 的 lightComplete.md
- 返回值必须可结构化克隆（纯数据）；不可克隆视为执行错误

## 边界取舍（文档必须显眼）

- **状态隔离**：任务文件的模块级变量每次执行都是新实例——run 内依赖的连接池/缓存需自建，不与进程内共享
- **硬杀副作用**：terminate 可能把事务/写操作砍在半路，由业务方幂等自担（与队列 at-least-once 语义一致）
- **冷启动开销**：worker 创建 + 模块加载为每次执行的固定成本，仅声明超时的任务承担；**冷启动计入 `timeoutMs` 计时**（超时从派发起算而非 run 开始）。**`timeoutMs` 上下限**（`scanTasks` 在 dev/build 启动期校验，越界直接报错不钳制）：**最小 60s**——声明超时的语义是"这是需要真取消的长任务"，一分钟内跑完的任务没必要声明，去掉 `timeoutMs` 走进程内执行即可（需要 deadline 进程内自行 `Promise.race`）；**最大 23h**——pg-boss 驱动按 timeoutMs 给 expire_in 预算而 pg-boss 12.28 前断言 expire_in 严格小于 24h，23h 上限兼容全部 pg-boss 12 小版本并保持跨驱动统一预算口径，为预算留约 1h 余量（需要更长执行预算拆可恢复的分段流水线，或改用 bullmq 驱动，Redis 无此上限）

## 相关模块

- `src/task/taskQueue.ts` — 语义层按 `meta.timeoutMs` 路由到本执行器
- `src/task/driverTypes.ts` — externalSignal 来源（驱动停机 abort）
