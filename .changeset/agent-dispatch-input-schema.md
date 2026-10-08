---
'@faapi/faapi': minor
'@faapi/agent': minor
---

agent-as-tool 派发入参支持 per-agent 富 schema 声明（结构性交接单）。

子代理派发工具（`agent-<name>`）此前固定暴露单字段 `{ input: string }` 交接单，字段语义只能写进 `inputDescription` 描述文字。现在 agent handler.ts 顶层声明 `interface Input` / `type Input` 即启用富 schema 模式：构建期 AST 提取生成 `agents/<name>/zod.js`（导出 `InputSchema`，复用 tool/task 的 zod 产物管线，coerce=false），字段 JSDoc 即主控 LLM 可见参数描述；`executeSubAgent` 执行前校验，失败按工具同语义回灌 `{ error }` 给主控重试。未声明的 agent 保持单字段 `input` + `inputDescription` 行为，完全向后兼容。

主包侧：`AgentMetadata` / 序列化清单新增 `inputTypeName` 字段（顶层 `Input` 导出检测）；`loadToolSchema` / `getToolSchemaPath` 参数放宽为最小结构 `{ filePath, inputTypeName? }`（新增导出 `SchemaSourceRef` 类型），同一加载器服务 tool 与 agent 两类 zod.js。agent 包侧：`AgentDeps` 新增可选 `resolveAgentInputSchema`（`createToolSchemaResolver` 返回值同时满足两个 resolver 签名，插件 setup 自动接线，任务内组装按需传入）；声明了 `inputTypeName` 但 zod.js 产物缺失时显式抛 `AgentError`（dev/prod 全量生成下只可能是产物异常，不静默退回单字段模式）。
