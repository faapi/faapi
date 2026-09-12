---
'@faapi/faapi': minor
---

agent 扫描支持多级嵌套目录：默认 pattern 由 `src/agents/*/handler.ts` 放宽为 `src/agents/**/handler.ts`（`**` 匹配零级或多级，平铺场景完全兼容），agent 注册名取 `agents/` 之后完整子路径并将 `/` 规范化为 `.`（如 `src/agents/easy-writing/wizard/handler.ts` → `easy-writing.wizard`）。`@agent` JSDoc 覆盖名行为不变。
