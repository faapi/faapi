# taskTypes

一句话概括：任务子系统的全部类型定义（任务元信息、扫描清单、运行时元数据、任务记录、客户端与队列接口、配置节），供各模块与公开导出共用。

## 为什么需要

scanTasks（构建期）、taskRegistry（运行时）、taskQueue（执行）、taskClient（触发入口）分处不同层，类型必须单一来源，避免各层重复声明导致字段漂移。

## 使用场景

- 业务方 `import type { FaapiTaskMeta, TaskClient, TaskContext, TaskJob } from '@faapi/faapi'`
- 框架内部 scanTasks → generateTaskArtifacts → taskRegistry → taskQueue 传递

## TaskContext.registries（任务侧注册表只读视图）

`TaskContext.registries: TaskRegistriesView` 为任务执行侧提供 app 已水合注册表的**只读访问**（agent/tool 元数据查询），任务内组装 agent（如跑 LLM 循环）不依赖 `getApp()`。任务执行注入 `createTaskRegistriesView(appRegistries)` 活引用（createAppBase 创建队列时传入），反映注册表实时状态。

视图只暴露查询方法（`get` / `list` / `resolve*`），不暴露 `hydrate` / `clear` 写接口——任务不是注册表的所有者。

## TaskContext.progress 与 TaskJob.progress（任务进度上报）

`TaskContext.progress?(value: unknown): void` 为可选能力：任务执行中主动上报进度，直写本进程任务记录 `TaskJob.progress`（`list()` 快照可见），供管理视图/日志观测长任务执行进展。仅 `running` 状态时生效，终态后调用被忽略。

`progress` 不做持久化（驱动侧无此概念）、不参与重试恢复——每次派发清空上一轮的 progress，本轮执行重新写入（终态后调用被忽略）；不调用 `progress` 的任务零开销，`TaskJob.progress` 不出现。

## TaskContext.emit / TaskClient.subscribe / listEvents（任务事件）

`TaskContext.emit?: (data: unknown) => void` 为可选能力：任务执行中发射过程事件（agent 流式 chunk、阶段标记等），落本进程事件缓冲并扇出订阅者，支持实时订阅（`TaskClient.subscribe`）与查询（`TaskClient.listEvents`）。仅 `running` 状态生效（终态后调用被忽略，与 progress 同口径）。

事件类型 `TaskEvent`（task/jobId/attempt/seq/at/data）、订阅与查询契约、保留边界（本进程有界内存）、取消/重试口径的**单点契约见 [taskEvents.md](./taskEvents.md)**。

## 任务声明（FaapiTaskMeta）

任务为**文件约定声明**（`src/tasks/<dir>/task.ts`）：`FaapiTaskMeta = { concurrency?, retries?, cron? }`。任务在进程内执行，config/registries 为活引用——不收 `timeoutMs` / `graceMs`，deadline 由业务自行 `Promise.race`，队列系统执行硬限由驱动兜底（见 driverTypes.md）。

`cron` 到点按任务名入队（与执行模型无关）。运行时判据即清单记录（TaskManifest / TaskMetadata），声明文件的完整扫描契约见 [scanTasks.md](./scanTasks.md)。

## TaskContext（任务执行上下文）

任务在进程内执行，上下文为单一 `TaskContext`（由声明文件种类即 `task.ts` 决定，见上节）：

| 维度 | `TaskContext` |
|------|---------------|
| `config` | `FaapiContextConfig` **必有**——活引用全量配置，与 handler `ctx.config` 同一对象，增强类型字段全可读、函数字段可调用（同进程） |
| `registries` | 活引用视图，反映实时状态 |
| `llm` | `registries.llm` 活引用（共享 providers 单例） |
| `log` | 直写 `config.log` 管道 |
| `progress` | 直写任务记录 |
| `emit` | 直写本进程事件缓冲 + 订阅扇出 |
| `tasks` | 活引用（与 `ctx.tasks` / `app.tasks` 同一 app 实例队列） |
| `suspend` / `resumed` | 直调：信封写驱动 `taskState` 存储 / 激活重投随执行上下文回传（见 taskSuspend.md） |
| 模块级状态 | 跨执行共享 |
| 取消 | 协作式（监听 job.signal 自行退出） |

run 的签名为 `TaskModule`。

## TaskContext.log（任务级日志器）

`TaskContext.log?: Logger` 为可选字段（直接构造 TaskContext 的测试/自定义执行器可不传；框架注入）：scope `task:<name>`，字段自动携带 `jobId`/`task`/`attempt`，输出走 `config.log` 全局管道。`createLogger` 直接构造，条目直写全局管道。

详见 `src/loggers/logger.md`。

## TaskContext.llm（轻量 LLM 补全通道）
`TaskContext.llm?: LlmComplete` 为可选字段（`@faapi/agent` 插件加载且 `agent.llms` 可解析时注入）：一次性 LLM 补全（分类/蒸馏/摘要/改写等）的官方出口——复用 `agent.llms` 同源配置与 provider 重试引擎，失败钩子内建、传输失败恒抛（不提供降级出口），详见 `@faapi/agent` 的 lightComplete.md。任务执行时刻从 `registries.llm` store 惰性读取（插件晚于队列构造注册，构造期快照会漏）——与 agent 循环共享同一 providers 单例。通道未注册时 `taskCtx.llm` 为 `undefined`（能力不存在，非降级）。

工具循环场景仍走 `registries.agent` 组装 `Agent`（见下节）——`llm` 只承接一次性补全，两者互补。

## TaskContext.carry（执行上下文携带管道）与 taskCtx.agent（静默组装通道）

`enqueue` / `enqueueSequence` / `enqueueBatch` 的 `opts.carry` 声明**执行上下文快照**（身份/标记等纯数据，如 `carry: { currentUserId: ctx.currentUserId }`）：随任务 envelope 持久化（驱动载荷包装形态，跨实例/重启正确），执行端还原到 `taskCtx.carry`（未携带/旧格式任务归一为空对象）。**身份在它天然存在的地方声明一次，队列只搬运**（Sidekiq Current / Temporal headers 同款模式）：

```ts
// HTTP handler 里入队——身份来自请求管线
await tasks.enqueue('distill', payload, { carry: { currentUserId: ctx.currentUserId } });

// 任务里静默消费——agent 通道自动以 carry 为执行 ctx 构造
export async function run(payload, taskCtx) {
  const agent = taskCtx.agent; // @faapi/agent 增强的 AgentHandle | undefined
  if (!agent) throw new Error('agent unavailable');
  return agent.stream(...); // agent:before-tool-call 订阅端读到 carry.currentUserId——门禁放行
}
```

行为约定：

- **纯数据校验**：carry 须为普通对象且可结构化克隆（要持久化到驱动存储跨实例/重启正确），含函数/symbol/不可克隆值在 **enqueue 时刻显式抛错**，不留到执行才炸
- **续投自动继承**：任务内 `taskCtx.tasks.enqueue*` 自动带上当前执行的 carry（显式传 carry 整体覆盖，不合并）；`tasks.resume` 激活重投继承挂起前的 carry
- **cron 触发**为空对象（无调用方上下文，业务按需在 run 内补）
- **`taskCtx.agent` 惰性通道**：首次访问经 `agentHandle` 工厂构造并缓存复用——执行 ctx 按 `createTaskToolContext` 配方合成（**carry 数据字段落顶层 + 契约字段 tasks/log/signal 后置**，见 [taskToolContext.md](./taskToolContext.md)，与 [AgentToolContext 契约](../runtime/agentToolContext.md) 对齐）；类型由 `@faapi/agent` 的 declare module 增强为 `AgentHandle | undefined`（未安装该包时类型与运行时一致：字段不存在）。插件未加载时 undefined（能力不存在非降级），手工组装走 `createAgentDeps`（见下节）

## TaskContext.tasks（任务侧任务客户端）

`TaskContext.tasks: TaskClient` 为**必有字段**：任务内入队/组投递/查询不绕 `getApp()`（全局访问器读的是 app 启动从不水合的默认实例）。与 handler `ctx.tasks` / `app.tasks` / `app:*` 事件载荷的 `{ tasks }` 指向同一 app 实例队列——活引用，直接调队列本体。

批量投递（串行有序 / 并行无序）/ fan-in / 记账语义见 [taskBatch.md](./taskBatch.md)。

任务读 `src/resources/` 静态文件统一走主包免传参 `readResource`（相对路径 + 只能读 resources 内文件，详见 [readResource.md](../utils/readResource.md)）——app 启动时的全局绑定即可读，无需手工传目录。

### 任务内组装 Agent（官方装配工厂）

任务内 new `Agent` 跑 LLM 循环时，deps 装配走 `@faapi/agent` 公开的 `createAgentDeps` 工厂（与插件 setup 单一实现）——`agentConfig` 直收 `taskCtx.config.agent` 读回的复合配置块，无需手拼访问器/schema 解析器（`resolveToolSchema` 由工厂内置 `createToolSchemaResolver` 接线——不要直连 `loadToolSchema`，它返回原始 zod 模块，不满足 `AgentDeps.resolveToolSchema` 契约的 `{ jsonSchema, validate }`）：

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
      // 任务无 HTTP 请求——契约 ctx 按任务配方合成（身份在 carry 数据字段落顶层），
      // tool handler 的硬闸与鉴权钩子照常读取。currentUserId 等自定义字段经
      // declare module '@faapi/faapi' 增强 AgentToolContext 后免 cast 直传
      ctx: createTaskToolContext({
        carry: { currentUserId: payload.userId },
        tasks: taskCtx.tasks,
        log: taskCtx.log,
        signal: taskCtx.signal,
      }),
    }),
  );
  return agent.run(payload.input, { agent: 'log-analyzer', provider });
}
```

装配工厂的行为约定（providers/llms 转换、overrides 浅合并、进程级复用建议）见 `@faapi/agent` 的 [agentDeps.md](../../../agent/src/agentDeps.md)；`AgentDeps.ctx` 为必填的 [AgentToolContext](../runtime/agentToolContext.md) 契约（三路径合成保证，无 app 场景用 `createStandaloneToolContext`）见 [agent.md](../../../agent/src/agent.md)「AgentDeps.ctx」章节；`AgentDeps` 各字段见 [agent.md](../../../agent/src/agent.md)。

## 相关模块

- 被本目录所有模块与 `src/configs/configTypes.ts`（TaskConfig）、`src/injection/registries.ts`（TaskRegistry）引用
- `src/injection/registries.ts` — `TaskRegistriesView` 类型与 `createTaskRegistriesView` 视图工厂（AppRegistries 的只读投影）
