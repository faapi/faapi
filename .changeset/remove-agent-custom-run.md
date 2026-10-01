---
'@faapi/faapi': major
'@faapi/agent': major
---

移除 agent 自定义 `run` 机制——agent 统一为声明式执行（config + 默认 reactLoop）。

- agent handler.ts 检测到 `export function/const run` 时构建期抛 `SchemaExtractionError`（含迁移指引）：编排场景**注册 tool**（有 schema 校验、trace 采集、鉴权钩子覆盖），多 agent 协作用 config.agents 声明 sub-agent（继承 provider、delta 冒泡、usage 整树上卷）
- 删除公开导出：`loadAgentModule` 函数与 `AgentModule` 类型、`AgentMetadata.hasRun` / `AgentManifest.hasRun` 字段、`AgentDeps.loadAgentModule`
- `AgentMetadata.filePath` 保留（声明文件定位与清单可观测性）；`getAgentEntry` 保留
- `systemPrompt` / `systemPromptFile` 二选一必填对全部文件型 agent 生效（config 豁免随 run 一并移除）
