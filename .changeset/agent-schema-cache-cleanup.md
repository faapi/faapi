---
"@faapi/faapi": minor
"@faapi/agent": minor
---

Agent 性能优化与死代码清理:

- @faapi/faapi: 删除 `scanAgents` / `scanTools` 的未使用 `_dist` 参数（参数名带 `_` 前缀，文档已注明未使用，所有调用方均不传）；同步修复 agent 相关文档与代码不一致
- @faapi/agent: Agent 类新增 tool schema 实例级缓存（`getToolSchema`），避免 `buildToolDefinitions` 与 `executeTool` 重复调用 `resolveToolSchema`；plugin.ts 提取 `resolveToolSchemaImpl` 为模块级函数，setup 内创建偏函数一次，工厂内复用，避免每次请求重建闭包
