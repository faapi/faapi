---
'@faapi/task-pgboss': patch
---

修复未声明 `timeoutMs` 的任务入队必抛 AssertionError：过期预算默认值 24h 整踩中 pg-boss 10 的排他上界断言（`expireIn/3600 < 24`），`send()` 在参数校验阶段即拒绝。默认值改为 24h − 1s（86399 秒），语义不变（仍是约一天的执行预算兜底），`defaultExpireSeconds` 的 JSDoc 与 README 注明上界为排他——显式配置 >= 86400 会被 pg-boss 拒绝
