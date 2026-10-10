# toolSchemaResolver（已下沉主包）

一句话概括：`createToolSchemaResolver` 的实现已迁移到主包 loader 域（`@faapi/faapi` 的 [toolSchemaResolver](../../faapi/src/loader/toolSchemaResolver.md)），本包 re-export 保持 `import { createToolSchemaResolver } from '@faapi/agent'` 导入路径不变。

## 为什么迁移

- **zod 同源**：resolver 运行时 import zod（`z.toJSONSchema` + `safeParse`），zod 是主包 peerDependency——留在本包会让两个包各持一份 zod 副本（`@faapi/faapi` 产物不 external 化 zod 时 inline），`z.toJSONSchema` 处理另一实例创建的 schema 存在实例分裂风险
- **测试设施共用**：主包的 [createAgentTestHarness](../../faapi/src/agentTestHarness.md)（`generated` 模式）直接复用同一实现，无需跨包反向依赖

`ToolSchemaResolution` 类型一并下沉主包，`AgentDeps` 经 `import type` 引用 + re-export（`from '@faapi/agent'` 导入路径不变）。

## 行为约定（迁移后不变）

- 工厂签名扩展 `dist` 可选项（显式产物目录，缺省走 dev on demand / `FAAPI_DIST` 全局解析）——向后兼容
- 完整行为契约（解析 / mtime 缓存 / 作用域 / dist 选项）见主包 [toolSchemaResolver.md](../../faapi/src/loader/toolSchemaResolver.md)

## 相关模块

- 主包 [toolSchemaResolver](../../faapi/src/loader/toolSchemaResolver.md) - 实现与契约单一来源
- [agent](./agent.md) - `AgentDeps.resolveToolSchema` / `resolveAgentInputSchema` 的消费方
- [plugin](./plugin.md) - 插件 setup 的调用方
