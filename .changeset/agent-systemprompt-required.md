---
'@faapi/faapi': minor
---

文件型 agent 的 `systemPrompt` 收紧为必填：config 未声明（无 config 导出、config 无 return 对象、config 缺该 key）时 `faapi build`/dev 构建期抛 `SchemaExtractionError`（带 file:line:column），不再静默降级为 `undefined` 运行时按"无人设"执行。提示词是 agent 人设与输出格式约定的必要组成，JSDoc `description` 只是用途说明不构成提示词；DB-driven skill 不经过此链路，`AgentCore.systemPrompt` 类型保持可选。注意：存量项目中未声明 `systemPrompt` 的 agent 升级后构建会失败，需补声明。
