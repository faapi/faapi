---
'@faapi/agent': minor
---

`AgentRuntimeConfig.maxHistoryTokens` 全链路接线生效——此前 plugin 已把 `config.agent.maxHistoryTokens` 拷入 runtimeConfig，但 `buildLoopConfig` 构造循环配置时从不读取该字段，全局配置静默失效（`reactLoop` 的历史裁剪永不触发，长循环对话历史无上限增长——恰是该配置要防的问题）。现在配置正确透传 `ReactLoopConfig.maxHistoryTokens`，超预算时按轮组裁掉最旧历史（system 与初始 user 保留），补接线回归测试。
