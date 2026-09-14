# toolSchemaResolver

一句话概括：`createToolSchemaResolver` 工厂——把 tool 的 zod.js 解析为 `ToolSchemaResolution`（JSON Schema + safeParse 校验函数），带 mtime 缓存，公开导出供插件与任务侧组装 `AgentDeps` 共用。

## 为什么需要

`AgentDeps.resolveToolSchema` 的契约是返回 `ToolSchemaResolution`（`{ jsonSchema, validate }`），但产生该值的装配逻辑（[loadToolSchema](../../faapi/src/loader/loadToolSchema.md) + `z.toJSONSchema` + `safeParse`）原本是插件 setup 内部实现，未公开导出。业务方在任务内手动组装 `Agent` 时（`taskCtx.registries` 只读视图 + 包级导出），唯一能拿到的 `loadToolSchema` 返回的是 `{ schema, schemaName }` 原始 zod 模块——直连后运行时 `schemaRes.validate is not a function`，报错不指向装配错误，且业务方被迫镜像框架内部实现（适配逻辑随框架演化漂移）。

## 使用场景

- **任务内组装 agent**（主要场景）：`src/tasks/<name>/task.ts` 内 new `Agent` 组装 deps 时，`resolveToolSchema` 用本工厂提供——任务侧 `TaskContext` 无 `rootDir`，缺省即用 `process.cwd()`（faapi 服务进程 cwd 即项目根）
- **插件 setup**：`@faapi/agent` 插件内部同样用本工厂（传 `ctx.rootDir`），插件与任务侧单一实现，不出现适配漂移

```ts
// src/tasks/log-analysis/task.ts
import { Agent } from '@faapi/agent';
import { createToolSchemaResolver } from '@faapi/agent';
import { loadToolModule, loadAgentModule } from '@faapi/faapi';

const resolveToolSchema = createToolSchemaResolver(); // rootDir 缺省 process.cwd()

export async function run(payload, taskCtx) {
  const agent = new Agent({
    providers, llms, rootDir: process.cwd(),
    getAgent: taskCtx.registries.agent.getAgent,
    /* ...其余 deps... */
    resolveToolSchema,
  });
  return agent.run(payload.input, { agent: 'log-analyzer', provider });
}
```

## 行为约定

- **解析**：`loadToolSchema` 返回 `undefined`（tool 无 `inputTypeName` / zod.js 不存在 / import 失败）→ 返回 `undefined`，agent 用自由 schema `{ type: 'object' }`；有 schema 时 `jsonSchema = z.toJSONSchema(schema)`，`validate = schema.safeParse` 包装（成功返回 coerce 后的 value，失败返回 error 消息）
- **缓存**：工厂闭包级 `Map<key, { mtimeMs, resolution }>`——缓存键 `zodPath#inputTypeName`，每次查找 `statSync` 一次做 mtime 自校验，mtime 变化即重新解析（dev reloadTools 重生成 zod.js 后自愈，prod 产物固化永远命中）；in-flight Promise 直接入缓存，同一 tool 的并发调用共享同一次解析
- **作用域**：每次 `createToolSchemaResolver` 调用返回独立缓存的 resolver——插件 setup 一次（root + sub-agent 共享）；任务侧建议模块级创建一次（隔离 worker 每次执行新模块图，缓存随执行重建；进程内任务跨执行复用）

## 相关模块

- [agent](./agent.md) —— `AgentDeps.resolveToolSchema` 契约与 `ToolSchemaResolution` 类型的定义方
- [plugin](./plugin.md) —— 插件 setup 调用本工厂创建 setup 闭包级 resolver
- faapi 核心 [loadToolSchema](../../faapi/src/loader/loadToolSchema.md) —— zod.js 加载（`ToolSchemaModule` → 本模块负责转为 `ToolSchemaResolution`）
- faapi 核心 [taskTypes](../../faapi/src/task/taskTypes.md) —— 任务侧 registries 只读视图（组装 agent 的元数据来源）
