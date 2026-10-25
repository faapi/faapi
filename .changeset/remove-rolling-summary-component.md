---
'@faapi/agent': minor
---

移除滚动摘要配方组件 `createRollingSummaryCompactor`（含 `plan`/`fold`/`block` 与 `RollingSummaryOptions`/`RollingSummaryCompactor`/`FoldPlan`/`SummaryComplete` 类型导出）——压缩与注入语义全部交还业务侧自搓。历史收集点维持现状：run/stream 返回完整 `messages`，续跑经 `config.messages` 回灌；会话级持久折叠的配方（折叠规划 / 轮次格式化 / 摘要合并提示词 / 注入纪律文案）不再由框架现货提供，in-loop 压缩仍走 `historyCompactor` 策略位（不变量守卫不变）。
