---
'@faapi/faapi': minor
---

命名规则收敛 + 移除 `@agent` / `@tool` JSDoc 覆盖名功能：

- **目录段白名单收敛共用模块**：agent / tool / task 三域的目录段白名单（`^[a-zA-Z0-9-]+$`）此前在各 scanner 内各自定义模块内常量，现收敛到 `src/naming/nameRules.ts`（`DIR_SEGMENT_PATTERN` + `LLM_TOOL_NAME_PATTERN` 唯一定义处）——规则调整不再需要三处同步。三 scanner 与 `subAgentToolName` 改为从共用模块 import；`LLM_TOOL_NAME_PATTERN` 公共导出路径不变（仍从 `@faapi/faapi` 导出）。
- **移除 `@agent` / `@tool` 覆盖名**：agent 名 / tool 名一律由目录路径推导（嵌套段用 `_` 连接），JSDoc 不再提供名字覆盖。handler 中出现有值的 `@agent` / `@tool` 标签时 AST 阶段抛迁移错误（对齐 agent 自定义 `run` 导出移除先例），无值裸标签维持原回退语义不报错。覆盖名字符集校验（`LLM_TOOL_NAME_PATTERN`）随之删除——覆盖面收窄后 `subAgentToolName` 运行时闸门与 `scanTools` 合成名校验已覆盖全部来源。

**迁移提示**（业务方需同步修改）：

1. 删除 agent handler 的 `@agent <name>` JSDoc 标签——需要不同注册名时改名目录（嵌套层级用目录表达）。
2. 删除 tool handler 的 `@tool <name>` JSDoc 标签——需要不同 tool 名时改名目录或函数名。
3. 残留标签不删会在构建期报错（含指引），不会静默忽略。
