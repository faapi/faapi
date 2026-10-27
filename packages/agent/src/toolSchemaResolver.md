# toolSchemaResolver

一句话概括：`createToolSchemaResolver` 的实现与契约单一来源在主包 loader 域（`@faapi/faapi` 的 [toolSchemaResolver](../../faapi/src/loaders/toolSchemaResolver.md)），本包 re-export 保持 `import { createToolSchemaResolver } from '@faapi/agent'` 导入路径不变；`ToolSchemaResolution` 类型同理（主包定义，`AgentDeps` 经 `import type` 引用 + re-export）。

完整行为契约（解析 / mtime 缓存 / 作用域 / dist 选项）见主包 [toolSchemaResolver.md](../../faapi/src/loaders/toolSchemaResolver.md)。

相关模块：[agent](./agent.md)（`AgentDeps.resolveToolSchema` / `resolveAgentInputSchema` 的消费方）、[plugin](./plugin.md)（插件 setup 的调用方）。
