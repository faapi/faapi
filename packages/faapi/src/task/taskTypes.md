# taskTypes

一句话概括：任务子系统的全部类型定义（任务元信息、扫描清单、运行时元数据、任务记录、客户端与队列接口、配置节），供各模块与公开导出共用。

## 为什么需要

scanTasks（构建期）、taskRegistry（运行时）、taskQueue（执行）、taskClient（触发入口）分处不同层，类型必须单一来源，避免各层重复声明导致字段漂移。

## 使用场景

- 业务方 `import type { FaapiTaskMeta, TaskClient, TaskContext, TaskJob, TaskRegistriesSnapshot } from '@faapi/faapi'`
- 框架内部 scanTasks → generateTaskArtifacts → taskRegistry → taskQueue 传递

## TaskContext.registries（任务侧注册表只读视图）

`TaskContext.registries: TaskRegistriesView` 为任务执行侧提供 app 已水合注册表的**只读访问**（agent/tool/skill 元数据查询），任务内组装 agent（如跑 LLM 循环）不再依赖 `getApp()`。两条执行路径都注入：

- **进程内路径**：注入 `createTaskRegistriesView(appRegistries)` 活引用（createAppBase 创建队列时传入）
- **隔离路径**（声明 `timeoutMs`）：语义层从视图生成 `TaskRegistriesSnapshot` 纯数据快照，postMessage 传入 worker 线程内重建视图（注册表含函数闭包不可跨线程，元数据本身是纯数据可克隆）；**快照语义**——视图反映派发时刻的注册表，执行中途的 reload 不影响当次执行

视图只暴露查询方法（`get` / `list` / `resolve*`），不暴露 `hydrate` / `clear` 写接口——任务不是注册表的所有者。

## TaskContext.progress 与 TaskJob.progress（任务进度上报）

`TaskContext.progress?(value: unknown): void` 为可选能力：任务执行中主动上报进度，语义层记入 `TaskJob.progress`（`list()` 快照可见），供管理视图/日志观测长任务执行进展。两条路径语义一致：

- **进程内路径**：`progress` 直写本进程任务记录（仅 `running` 状态时生效，终态后调用被忽略）
- **隔离路径**（声明 `timeoutMs`）：worker 内经 `{ type: 'progress' }` 消息回传宿主 `onProgress` 回调，宿主写记录；取消判定后（宽限期内）到达的 progress 忽略

`progress` 不做持久化（驱动侧无此概念）、不参与重试恢复——每次派发清空上一轮的 progress，本轮执行重新写入（终态后调用被忽略）；值必须可结构化克隆（隔离路径经 postMessage，不可克隆按执行错误处理）。不调用 `progress` 的任务零开销，`TaskJob.progress` 不出现。

## TaskContext.log（任务级日志器）

`TaskContext.log?: Logger` 为可选字段（直接构造 TaskContext 的测试/自定义执行器可不传；框架两条执行路径均注入）：scope `task:<name>`，字段自动携带 `jobId`/`task`/`attempt`，输出走 `config.log` 全局管道。两条路径语义一致：

- **进程内路径**：`createLogger` 直接构造，条目直写全局管道
- **隔离路径**（声明 `timeoutMs`）：日志配置（level/scope/fields，纯数据）随派发下发，worker 内联日志器做级别预过滤后把条目经 `{ type: 'log' }` 消息回传宿主 `onLog`（即 `writeLogEntry`）统一输出——自定义 sink 同样覆盖隔离任务；取消判定后（宽限期内）到达的条目不采纳（超时判定即终局）；fields 不可克隆时丢弃 fields 保底输出 warning 标记（已记入项目根 `fallback.md`）

详见 `src/logger/logger.md`。

### 任务内组装 Agent（完整 deps）

任务内 new `Agent` 跑 LLM 循环时，deps 从 `registries` 视图 + 包级导出组装；`resolveToolSchema` 用 `@faapi/agent` 公开的 `createToolSchemaResolver` 工厂（不要直连 `loadToolSchema`——它返回 `{ schema, schemaName }` 原始 zod 模块，不满足 `AgentDeps.resolveToolSchema` 契约的 `{ jsonSchema, validate }`）：

```ts
// src/tasks/log-analysis/task.ts
import { Agent, createToolSchemaResolver } from '@faapi/agent';
import { loadToolModule, loadAgentModule } from '@faapi/faapi';

// 模块级创建一次（rootDir 缺省 process.cwd()，faapi 服务进程 cwd 即项目根）
const resolveToolSchema = createToolSchemaResolver();

export async function run(payload, taskCtx) {
  const agent = new Agent({
    providers,                       // 外部 provider 模式：调用方传 provider 实例
    llms,                            // config.agent.llms（可空对象）
    rootDir: process.cwd(),
    getAgent: taskCtx.registries.agent.getAgent,
    getAgentEntry: taskCtx.registries.agent.getAgentEntry,
    getTool: taskCtx.registries.tool.get,
    resolveAgentTools: taskCtx.registries.agent.resolveAgentTools,
    resolveSubAgents: taskCtx.registries.agent.resolveSubAgents,
    loadToolModule: (filePath, functionName) => loadToolModule(filePath, functionName, process.cwd()),
    loadAgentModule: (filePath, hasRun) => loadAgentModule(filePath, hasRun, process.cwd()),
    resolveToolSchema,               // zod.js → JSON Schema + safeParse 校验（带 mtime 缓存）
  });
  return agent.run(payload.input, { agent: 'log-analyzer', provider });
}
```

工厂行为（缓存、`undefined` 语义）见 `@faapi/agent` 的 [toolSchemaResolver.md](../../../agent/src/toolSchemaResolver.md)；`AgentDeps` 各字段见 [agent.md](../../../agent/src/agent.md)。

## 相关模块

- 被本目录所有模块与 `src/config/configTypes.ts`（TaskConfig）、`src/injection/registries.ts`（TaskRegistry）引用
- `src/injection/registries.ts` — `TaskRegistriesView` 类型与 `createTaskRegistriesView` 视图工厂（AppRegistries 的只读投影）
