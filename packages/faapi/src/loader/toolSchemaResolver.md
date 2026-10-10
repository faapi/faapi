# toolSchemaResolver

一句话概括：`createToolSchemaResolver` 工厂——把 zod.js 解析为 `ToolSchemaResolution`（JSON Schema + safeParse 校验函数），带 mtime 缓存；同一实例同时服务常规 tool schema（`resolveToolSchema`）与 sub-agent 派发入参 schema（`resolveAgentInputSchema`）。实现下沉主包（zod peer 同源 + 测试设施共用），`@faapi/agent` re-export 保持导入路径不变。

## 为什么需要

`AgentDeps.resolveToolSchema` 的契约是返回 `ToolSchemaResolution`（`{ jsonSchema, validate }`），但产生该值的装配逻辑（[loadToolSchema](./loadToolSchema.md) + `z.toJSONSchema` + `safeParse`）原本是插件 setup 内部实现，未公开导出。业务方在任务内手动组装 `Agent` 时（`taskCtx.registries` 只读视图 + 包级导出），唯一能拿到的 `loadToolSchema` 返回的是 `{ schema, schemaName }` 原始 zod 模块——直连后运行时 `schemaRes.validate is not a function`，报错不指向装配错误，且业务方被迫镜像框架内部实现（适配逻辑随框架演化漂移）。

resolver 参数取最小结构 `{ filePath, inputTypeName? }`（zod.js 定位的全部所需）——tool 元数据（`ToolMetadata`）与 agent 完整元数据（`AgentMetadata`，派发入参 schema 声明场景）均满足，一个工厂两个注入点。

实现位于主包 loader 域（原 `@faapi/agent/src/toolSchemaResolver.ts`）：resolver 运行时 import zod，zod 是主包 peerDependency——下沉后解析器与生成的 zod.js 产物共享同一 zod 实例（留在 agent 包则两个包各持一份 zod 副本，`z.toJSONSchema` 处理另一实例创建的 schema 存在实例分裂风险）；同时测试设施 [agentTestHarness](../agentTestHarness.md)（主包）直接复用同一实现，无需跨包反向依赖。

## 使用场景

- **任务内组装 agent**：`src/tasks/<name>/task.ts` 内 new `Agent` 组装 deps 时，`resolveToolSchema`（与 `resolveAgentInputSchema`）用本工厂——任务侧 `TaskContext` 无 `rootDir`，缺省即用 `process.cwd()`（faapi 服务进程 cwd 即项目根）
- **插件 setup**：`@faapi/agent` 插件内部同样用本工厂（传 `ctx.rootDir`），插件与任务侧单一实现，不出现适配漂移
- **测试设施**：`createAgentTestHarness` 的 `generated` 模式（传显式 `dist` 指向临时产物目录）

任务内组装 agent 时无需手拼 deps——官方装配工厂 `createAgentDeps`（`@faapi/agent`，见其 agentDeps.md）内部已用本工厂接好 `resolveToolSchema` / `resolveAgentInputSchema`（同一实例，tool 与派发入参共用缓存）：

```ts
// src/tasks/log-analysis/task.ts
import { Agent, createAgentDeps } from '@faapi/agent';

export async function run(payload, taskCtx) {
  const agent = new Agent(
    createAgentDeps({
      registries: taskCtx.registries, // 只读视图直传
      llms,                           // 缺省空——外部 provider 模式经 run options.provider 注入
    }),
  );
  return agent.run(payload.input, { agent: 'log-analyzer', provider });
}
```

需要富化/装饰等业务差异时经 `overrides` 覆盖对应 deps 字段；只有完全脱离工厂的深度定制才直拼 deps（此时 `resolveToolSchema` / `resolveAgentInputSchema` 仍建议用本工厂产出）。

## 行为约定

- **解析**：`loadToolSchema` 返回 `undefined`（无 `inputTypeName` / zod.js 不存在 / import 失败）→ 返回 `undefined`；有 schema 时 `jsonSchema = z.toJSONSchema(schema)`，`validate = schema.safeParse` 包装（成功返回 coerce 后的 value，失败返回 error 消息）。tool 侧 `undefined` → agent 用自由 schema `{ type: 'object' }`；agent 派发侧 `undefined` 的语义（声明了 `inputTypeName` 即产物异常，显式抛错）由 `@faapi/agent` 的 agent.md「派发入参 schema 声明」定义，本工厂只如实返回
- **缓存**：工厂闭包级 `Map<key, { mtimeMs, resolution }>`——缓存键 `zodPath#inputTypeName`，每次查找 `statSync` 一次做 mtime 自校验，mtime 变化即重新解析（dev reload 后重生成 zod.js 自愈，prod 产物固化永远命中）；in-flight Promise 直接入缓存，同一来源的并发调用共享同一次解析。tool 与 agent 入参共用同一实例时缓存共享（`zod.js` 路径不同，键天然不冲突）
- **作用域**：每次 `createToolSchemaResolver` 调用返回独立缓存的 resolver——插件 setup 一次（root + sub-agent 共享）；任务侧建议模块级创建一次（隔离 worker 每次执行新模块图，缓存随执行重建；进程内任务跨执行复用）
- **dist 选项**（可选）：显式指定产物目录（如测试设施的临时目录），不传时走 dev on demand / `FAAPI_DIST` 全局解析——与生产 dev/prod 默认路径一致。传显式 dist 时不读全局状态，与同进程的生产路径互不干扰

## 相关模块

- `@faapi/agent` 的 [agent](../../../agent/src/agent.md) —— `AgentDeps.resolveToolSchema` 契约的定义方与消费方
- `@faapi/agent` 的 [plugin](../../../agent/src/plugin.md) —— 插件 setup 调用本工厂创建 setup 闭包级 resolver
- [loadToolSchema](./loadToolSchema.md) —— zod.js 加载（`ToolSchemaModule` → 本模块负责转为 `ToolSchemaResolution`）
- [agentTestHarness](../agentTestHarness.md) —— 测试设施 `generated` 模式的消费方
- faapi 核心 [taskTypes](../task/taskTypes.md) —— 任务侧 registries 只读视图（组装 agent 的元数据来源）
