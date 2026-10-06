---
'@faapi/faapi': minor
---

任务 meta 字面量守卫：`task.ts` 声明了 meta 字段（`concurrency` / `retries` / `timeoutMs` / `graceMs` / `cron`）但值不是可识别字面量（表达式如 `30 * 60_000`、动态值如 `Number(process.env.X)`）时，扫描期 `console.warn` 显式警告后忽略该字段，不再静默丢弃——此前静默丢弃会让声明了 `timeoutMs` 的任务悄悄退化进程内执行（无超时、无隔离真终止）且无任何信号。同时修正文档中的表达式示例（`timeoutMs: 30 * 60_000` → 字面量 `1_800_000`）并明确「meta 值必须是纯字面量」约束（数字字段支持下划线分隔，`cron` 为引号字符串）。
