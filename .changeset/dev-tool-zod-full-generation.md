---
'@faapi/faapi': patch
---

fix(faapi): dev 模式 tool zod.js 与 build 一致全量生成，修复 tool 入参校验与 LLM 可见参数 schema 在 dev 静默缺失

此前文档描述 dev 下 tool zod.js「首次请求按需生成（`ensureToolSchemaGenerated`）」，该函数从未实现——dev 启动与 `reloadTools` 实际均跳过 zod.js 生成，声明了 `Input` 的 tool 在 dev 由自由 schema `{ type: 'object' }` 兜底：LLM 看不到参数描述、入参不校验，与 build 行为静默不一致。现在 dev 启动（`generateToolArtifactsForDev`）与 watcher 触发的 `reloadTools` 均全量生成 tool zod.js，与 build/agent/task 同款（tool 清单的 AST 增强本就要创建 Program，按需化无启动收益）。`generateToolArtifacts` 的 `skipSchema` 选项口径收敛为仅供测试设施 free-form 模式。注意：tool `Input` 含暂不支持的 AST 语法时 dev 启动即显式报错（此前静默旁路），与 build 行为对齐。
