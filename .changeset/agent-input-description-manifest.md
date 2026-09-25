---
'@faapi/faapi': minor
---

修复 agent config 块 `inputDescription` 声明后运行时不生效：提取器正确提取并校验该字段，但 `serializeAgents` 序列化与 `hydrateAgents` 水合的字段映射均漏掉它，导致 `faapi-agents.js` 清单不含该字段、运行时 agent-as-tool 派发工具的 `input` description 恒用框架默认文案。现声明的 `inputDescription` 经清单序列化与水合完整带入运行时元数据。
