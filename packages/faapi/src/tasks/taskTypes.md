# taskTypes

一句话概括：任务子系统的全部类型定义（任务元信息、扫描清单、运行时元数据、任务记录、客户端与队列接口、配置节），供各模块与公开导出共用。

## 为什么需要

scanTasks（构建期）、taskRegistry（运行时）、taskQueue（执行）、taskClient（触发入口）分处不同层，类型必须单一来源，避免各层重复声明导致字段漂移。

## 使用场景

- 业务方 `import type { FaapiTaskMeta, FaapiWorkerTaskMeta, TaskClient, TaskContext, IsolatedTaskContext, TaskJob, TaskRegistriesSnapshot } from '@faapi/faapi'`
- 框架内部 scanTasks → generateTaskArtifacts → taskRegistry → taskQueue 传递

## TaskContext.registries（任务侧注册表只读视图）

`TaskContext.registries: TaskRegistriesView` 为任务执行侧提供 app 已水合注册表的**只读访问**（agent/tool 元数据查询），任务内组装 agent（如跑 LLM 循环）不再依赖 `getApp()`。两条执行路径都注入：

- **进程内路径**：注入 `createTaskRegistriesView(appRegistries)` 活引用（createAppBase 创建队列时传入）
- **隔离路径**（`worker.ts`）：语义层从视图生成 `TaskRegistriesSnapshot` 纯数据快照，postMessage 传入 worker 线程内重建视图（注册表含函数闭包不可跨线程，元数据本身是纯数据可克隆）；**快照语义**——视图反映派发时刻的注册表，执行中途的 reload 不影响当次执行

视图只暴露查询方法（`get` / `list` / `resolve*`），不暴露 `hydrate` / `clear` 写接口——任务不是注册表的所有者。

## TaskContext.progress 与 TaskJob.progress（任务进度上报）

`TaskContext.progress?(value: unknown): void` 为可选能力：任务执行中主动上报进度，语义层记入 `TaskJob.progress`（`list()` 快照可见），供管理视图/日志观测长任务执行进展。两条路径语义一致：

- **进程内路径**：`progress` 直写本进程任务记录（仅 `running` 状态时生效，终态后调用被忽略）
- **隔离路径**（`worker.ts`）：worker 内经 `{ type: 'progress' }` 消息回传宿主 `onProgress` 回调，宿主写记录；取消判定后（宽限期内）到达的 progress 忽略

`progress` 不做持久化（驱动侧无此概念）、不参与重试恢复——每次派发清空上一轮的 progress，本轮执行重新写入（终态后调用被忽略）；值必须可结构化克隆（隔离路径经 postMessage，不可克隆按执行错误处理）。不调用 `progress` 的任务零开销，`TaskJob.progress` 不出现。

## TaskContext.emit / TaskClient.subscribe / listEvents（任务事件）

`TaskContext.emit? / IsolatedTaskContext.emit?: (data: unknown) => void` 为可选能力：任务执行中发射过程事件（agent 流式 chunk、阶段标记等），宿主侧有界保留并支持实时订阅（`TaskClient.subscribe`）与查询（`TaskClient.listEvents`）。仅 `running` 状态生效（终态后调用被忽略，与 progress 同口径）；隔离路径值经 `{ type: 'event' }` 消息回传宿主——值须可结构化克隆（不可克隆按执行错误处理）。

事件类型 `TaskEvent`（task/jobId/attempt/seq/at/data）、订阅与查询契约、保留边界（本进程有界内存）、取消/重试口径的**单点契约见 [taskEvents.md](./taskEvents.md)**。

## 两种任务声明（FaapiTaskMeta / FaapiWorkerTaskMeta）

进程内与隔离是**两种外部声明 API**，文件名即语义（扫描期判定，构建期显式失败，不静默降级）：

- `src/tasks/<dir>/task.ts` → **进程内任务**（`mode: 'inline'`）：`FaapiTaskMeta = { concurrency?, retries?, cron? }`——**不收 `timeoutMs` / `graceMs`**（声明即构建期报错，迁移指引：改名 `worker.ts`；超时上限保护不是隔离的理由，进程内需要 deadline 自行 `Promise.race`）
- `src/tasks/<dir>/worker.ts` → **隔离任务**（`mode: 'isolated'`）：`FaapiWorkerTaskMeta = { timeoutMs, graceMs?, concurrency?, retries?, cron? }`——**`timeoutMs` 必填**（隔离语义即"需要真取消的长任务"，执行预算显式声明；上下限校验见 taskWorker.md）

`cron` 两种声明通用（cron 到点按任务名入队，与执行路径无关）。清单记录携带 `mode`（TaskManifest / TaskMetadata / SerializedTaskRecord 必填字段），运行时判据即 `mode`（taskQueue.runJob），不再从 timeoutMs 有无推断。声明文件的完整扫描契约见 [scanTasks.md](./scanTasks.md)。

## TaskContext / IsolatedTaskContext（两条执行路径显式分开）

进程内与隔离执行的行为差异是实质性的，两个上下文类型**显式分开**，由声明文件种类决定路径（`task.ts` 进程内 / `worker.ts` 隔离，见上节）；业务按路径标注 ctx 类型，边界编译期可见：

| 维度 | `TaskContext`（进程内，默认） | `IsolatedTaskContext`（隔离） |
|------|------------------------------|------------------------------|
| `config` | `FaapiContextConfig` **必有**——活引用全量配置，与 handler `ctx.config` 同一对象，增强类型字段全可读、函数字段可调用（同进程） | **必有**——派发时刻**纯数据快照**（`collectConfigSnapshot`，见 configSnapshot.md）：函数值（lifecycle 钩子 / `task.onFailed` / log sink / middlewares 等宿主行为面）不进快照（与 registries 快照同款边界），其余值结构化克隆保真（Date/Map/Set 原样）；含非函数不可克隆值时**派发显式报错**（列路径），不剔除不降级 |
| `registries` | 活引用视图，反映实时状态 | 派发时刻**快照**在 worker 内重建，中途 reload 不影响当次执行 |
| `llm` | `registries.llm` 活引用（共享 providers 单例） | worker 内按 `agent.llms` 快照重建；llms 配置但不可解析 → 任务显式失败 |
| `log` | 直写 `config.log` 管道 | postMessage 回传宿主输出——**fields 须可结构化克隆**（不可克隆按执行错误处理） |
| `progress` | 直写任务记录 | postMessage 回传——**值须可结构化克隆**（不可克隆按执行错误处理） |
| `emit` | 直写本进程事件缓冲 + 订阅扇出 | postMessage 回传——**值须可结构化克隆**（不可克隆按执行错误处理），宽限期内不采纳 |
| `tasks` | 活引用（与 `ctx.tasks` / `app.tasks` 同一 app 实例队列） | 代理对象——全方法经 postMessage RPC 回传宿主执行，**参数与返回值须可结构化克隆**（不可克隆按执行错误处理） |
| `suspend` / `resumed` | 直调：信封写驱动 `taskState` 存储 / 激活重投随执行上下文回传 | RPC 回传宿主执行**同一信封写入**（state 须可结构化克隆，驱动无 `taskState` 错误原样回传）/ 随 run 消息透传——**语义与进程内零差**（见 taskSuspend.md） |
| 模块级状态 | 跨执行共享 | 每次执行独立 |
| 取消 | 协作式（监听 signal 自行退出） | 两段式真终止（abort 宽限 → terminate 硬杀） |

误用路径的暴露方式：隔离任务的 ctx 为**快照语义**（config/registries 反映派发时刻状态，执行中途变更不影响当次执行）；未标注 ctx 的任务误访问则是响亮的 TypeError（undefined 上取属性）；**ctx 类型标注与文件种类不符（worker.ts 标 `TaskContext` / task.ts 标 `IsolatedTaskContext`）在构建期报错**（generateTaskArtifacts AST 校验，路径错注从运行时静默变构建期失败）。run 的签名按文件种类二选一：`TaskModule`（进程内）/ `IsolatedTaskModule`（隔离）。

## TaskContext.log（任务级日志器）

`TaskContext.log?: Logger` 为可选字段（直接构造 TaskContext 的测试/自定义执行器可不传；框架两条执行路径均注入）：scope `task:<name>`，字段自动携带 `jobId`/`task`/`attempt`，输出走 `config.log` 全局管道。两条路径语义一致：

- **进程内路径**：`createLogger` 直接构造，条目直写全局管道
- **隔离路径**（`worker.ts`）：日志配置（level/scope/fields，纯数据）随派发下发，worker 内联日志器做级别预过滤后把条目经 `{ type: 'log' }` 消息回传宿主 `onLog`（即 `writeLogEntry`）统一输出——自定义 sink 同样覆盖隔离任务；取消判定后（宽限期内）到达的条目不采纳（超时判定即终局）；fields 不可克隆（postMessage 抛 `DataCloneError`）时按执行错误处理——一条日志的字段失败终止任务执行，与 progress 同语义（显式失败优于静默丢字段；业务侧将 fields 保持为可克隆纯数据即可避免）

详见 `src/loggers/logger.md`。

## TaskContext.llm（轻量 LLM 补全通道）
`TaskContext.llm?: LlmComplete` 为可选字段（`@faapi/agent` 插件加载且 `agent.llms` 可解析时注入）：一次性 LLM 补全（分类/蒸馏/摘要/改写等）的官方出口——复用 `agent.llms` 同源配置与 provider 重试引擎，失败钩子内建、传输失败恒抛（不提供降级出口），详见 `@faapi/agent` 的 lightComplete.md。两条路径：

- **进程内路径**：任务执行时刻从 `registries.llm` store 惰性读取（插件晚于队列构造注册，构造期快照会漏）——与 agent 循环共享同一 providers 单例
- **隔离路径**（`worker.ts`）：channel 是函数闭包不可跨线程——`agent.llms` 纯数据快照（`TaskQueueDeps.llms`，可结构化克隆）随派发下发，worker 内动态加载 `@faapi/agent` 重建实例（`workerEntry.buildLlmChannel`，specifier 变量拼接、与 `loadTaskDriver` 加载驱动子包同策略）。**llms 已配置但 `@faapi/agent` 不可解析 → 显式抛错**（含安装指引），任务失败——配置声明了能力而环境不能交付属环境错误，fail fast；llms 未配置时不触发加载、`taskCtx.llm` 为 `undefined`（能力不存在，非降级）

工具循环场景仍走 `registries.agent` 组装 `Agent`（见下节）——`llm` 只承接一次性补全，两者互补。

## TaskContext.carry（执行上下文携带管道）与 taskCtx.agent（静默组装通道）

`enqueue` / `enqueueGroup` / `enqueueChain` 的 `opts.carry` 声明**执行上下文快照**（身份/标记等纯数据，如 `carry: { currentUserId: ctx.currentUserId }`）：随任务 envelope 持久化（驱动载荷包装形态，跨实例/重启正确），执行端还原到 `taskCtx.carry`（两条路径均注入；未携带/旧格式任务归一为空对象）。**身份在它天然存在的地方声明一次，队列只搬运**（Sidekiq Current / Temporal headers 同款模式）：

```ts
// HTTP handler 里入队——身份来自请求管线
await tasks.enqueue('distill', payload, { carry: { currentUserId: ctx.currentUserId } });

// 任务里静默消费——agent 通道自动以 carry 为执行 ctx 构造
export async function run(payload, taskCtx) {
  const agent = taskCtx.agent; // @faapi/agent 增强的 AgentHandle | undefined
  if (!agent) throw new Error('agent unavailable');
  return agent.stream(...); // authHooks 读到 carry.currentUserId——门禁放行
}
```

行为约定：

- **纯数据校验**：carry 须为普通对象且可结构化克隆（要持久化 + 跨隔离 worker 线程），含函数/symbol/不可克隆值在 **enqueue 时刻显式抛错**（与 config 快照同款边界，不留到派发才炸）
- **续投自动继承**：任务内 `taskCtx.tasks.enqueue*` 自动带上当前执行的 carry（显式传 carry 整体覆盖，不合并）；`tasks.resume` 激活重投继承挂起前的 carry
- **cron 触发**为空对象（无调用方上下文，业务按需在 run 内补）
- **`taskCtx.agent` 惰性通道**（仅进程内任务）：首次访问经 `agentHandle` 工厂以 `{ ...taskCtx.carry }` 为执行 ctx 构造并缓存复用——与 HTTP 请求链的 `agent` 参数注入同一份 baseDeps（插件 setup 闭包）；类型由 `@faapi/agent` 的 declare module 增强为 `AgentHandle | undefined`（未安装该包时类型与运行时一致：字段不存在）。**隔离任务无此通道**（恒 undefined）——agentHandle 工厂为宿主闭包不可跨线程，隔离任务跑 agent 走 `createAgentDeps` 编程式组装（见下节）

## TaskContext.tasks（任务侧任务客户端）

`TaskContext.tasks: TaskClient` 为**必有字段**（两条执行路径均注入）：任务内入队/组投递/查询不再绕 `getApp()`（隔离 worker 内 `getApp()` 本就不可用，全局访问器读的是 app 启动从不水合的默认实例）。与 handler `ctx.tasks` / `app.tasks` / lifecycle `{ tasks }` 指向同一 app 实例队列：

- **进程内路径**：活引用——直接调队列本体
- **隔离路径**：worker 内代理对象——全方法经 `{ type: 'tasks-call' }` 消息回传宿主执行（宿主走完整 enqueue 通道：存在性检查 + payload 校验 + 驱动入队 + 本地记录），结果/错误按 seq 匹配回传；**参数与返回值须可结构化克隆**（不可克隆按执行错误处理，与 progress/log 同口径）；挂起的调用随任务超时两段式取消一并终止，无独立超时

组投递 / fan-in / 记账语义见 [taskGroups.md](./taskGroups.md)。

## TaskContext.resourcesDir（已删除）

`TaskContext.resourcesDir` 数据字段已删除——任务读静态文件统一走主包免传参 `readResource`（相对路径 + 只能读 resources 内文件，详见 [readResource.md](../utils/readResource.md)）：

```ts
// src/tasks/report/task.ts
import { readResource } from '@faapi/faapi';

export async function run() {
  return readResource('prompts/report.md', 'utf-8');
}
```

隔离路径为纯字符串随快照 postMessage 传入（可结构化克隆）：进程内经 app 启动时的全局绑定即可读；隔离 worker 中 wrapper 在 run 派发前把快照值播种到全局读取根——所以 worker 内 `readResource` 与 agent `systemPromptFile` 都自动可用，无需手工传目录。`TaskQueueDeps.resourcesDir` 保留为内部字段——仅作隔离 worker 读取根播种的数据源（不进业务可见的 TaskContext）。

### 任务内组装 Agent（官方装配工厂）

任务内 new `Agent` 跑 LLM 循环时，deps 装配走 `@faapi/agent` 公开的 `createAgentDeps` 工厂（与插件 setup 单一实现）——`agentConfig` 直收 `taskCtx.config.agent` 读回的复合配置块，不再手拼访问器/schema 解析器（`resolveToolSchema` 由工厂内置 `createToolSchemaResolver` 接线——不要直连 `loadToolSchema`，它返回原始 zod 模块，不满足 `AgentDeps.resolveToolSchema` 契约的 `{ jsonSchema, validate }`）：

```ts
// src/tasks/log-analysis/task.ts
import { Agent, createAgentDeps } from '@faapi/agent';
import type { AgentConfig } from '@faapi/faapi';

export async function run(payload, taskCtx) {
  // 配置单一来源：faapi.config.ts 的 agent 块，taskCtx.config 活引用读回
  const agentConfig = taskCtx.config.agent as AgentConfig | undefined;
  const agent = new Agent(
    createAgentDeps({
      registries: taskCtx.registries, // 只读视图，最小结构直传
      agentConfig,
      // 任务无 HTTP 请求——把鉴权身份塞进窄 ctx（Partial<FaapiContext>），tool handler
      // 的硬闸（ctx?.currentUserId === undefined 拒绝）与鉴权钩子照常读取。
      // currentUserId 等自定义字段经 declare module '@faapi/faapi' 增强 FaapiContext 后免 cast 直传
      ctx: { currentUserId: payload.userId },
    }),
  );
  return agent.run(payload.input, { agent: 'log-analyzer', provider });
}
```

装配工厂的行为约定（providers/llms 转换、overrides 浅合并、进程级复用建议）见 `@faapi/agent` 的 [agentDeps.md](../../../agent/src/agentDeps.md)；`ctx` 纯透传语义（框架零读取，HTTP 完整 ctx / 任务窄对象 / 编程式 undefined 三种来源）见 [agent.md](../../../agent/src/agent.md)「AgentDeps.ctx」章节；`AgentDeps` 各字段见 [agent.md](../../../agent/src/agent.md)。

## 相关模块

- 被本目录所有模块与 `src/configs/configTypes.ts`（TaskConfig）、`src/injection/registries.ts`（TaskRegistry）引用
- `src/injection/registries.ts` — `TaskRegistriesView` 类型与 `createTaskRegistriesView` 视图工厂（AppRegistries 的只读投影）
