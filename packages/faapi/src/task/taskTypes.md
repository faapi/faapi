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
