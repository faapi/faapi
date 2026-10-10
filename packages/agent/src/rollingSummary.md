# rollingSummary（滚动摘要现货组件）

一句话概括：可选的摘要式历史折叠配方组件（`createRollingSummaryCompactor`）——折叠计划、轮次格式化、摘要合并、注入块四个纯函数件，业务可整体不用、可覆盖其中每个配方参数；组件无状态，折叠状态（prior summary / summarizedCount）的存储是业务表设计。

## 为什么需要

长对话 agent 的历史控量：早期轮次折叠成滚动摘要，注入时以「摘要 + 最近若干条原文」替代全量原文。机械（折叠计划公式、轮次行格式、合并提示词结构、注入纪律文案）每项目复刻（业务实证：writer `chat-summary.ts` 全套手搓）；而摘要提示词全文、保留条数、存储位置全是业务决策——框架只沉淀配方，不发明策略。

## 使用场景

- 会话级持久折叠（典型，业务实证形态）：轮终态经 `plan(totalCount, summarizedCount)` 规划折叠区间 → 后台任务 `fold(既有摘要, 区间轮次)` 生成新摘要 → 持久化到业务表（如会话列）→ 组装发送消息时 `block(摘要)` 注入
- 与策略位（[historyCompaction.md](./historyCompaction.md)）的关系：**正交、不自动接线**——组件服务「会话级持久折叠」，策略位服务「in-loop 现场压缩」；业务可只用组件（配 `maxHistoryTokens` 截断兜底），也可自写 compactor 接策略位

## 配方参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `complete` | 必填 | 摘要生成通道——接轻量补全签名（字符串进字符串出，复用 provider 重试引擎；`LlmComplete` / `taskCtx.llm` 直传） |
| `keepRecent` | 20 | 保持原文的最近消息条数 |
| `foldBatch` | 10 | 折叠批次：溢出攒满该条数才折叠（防频繁折叠） |
| `maxSummaryChars` | 600 | 滚动摘要长度上限——**生成端约束**（写进默认提示词），不做二次截断 |
| `summarySystem` | 保守骨架 | 摘要生成提示词全文（业务配方位，经 `complete` 的 `system` 传入；正式使用应覆盖——骨架是通用保守版，含防注入条款） |
| `formatTurn` | role→用户/AI 映射 | 轮次行格式（`用户:内容` / `AI:内容`，content trim） |

## 语义契约

- **`plan(totalCount, summarizedCount)`**：溢出 = 总数 − 已折叠 − 保留；攒满一个批次才折，一次把溢出全部折掉，返回 `[from, to)`（0 起，左闭右开）；无计划返回 `null`
- **`fold(previousSummary, turns)`**：既有摘要（合并基准，可为 null）+ 早期轮次 → 调 `complete` 生成合并后的新摘要；`complete` 失败**恒抛**（禁降级，重试与否业务自决）
- **`block(summary)`**：`<conversation-summary>` 注入块，四件套纪律文案（非用户输入声明 / 延续任务脉络的行为指令 / 静默——不复述不提及本块 / 摘要正文）由框架统一兜底，**不开放改写**——那是防提示注入的框架纪律（同 agent-universal-protocol 先例）；空摘要返回空串（不注入空块）
- 注入块的防注入条款同时声明「任务进度与用户要求仍然有效」——行为指令按「延续任务脉络」给，不按「可自由忽略」给

## 相关模块

- [historyCompaction.md](./historyCompaction.md) - 策略位（正交接缝，不自动接线）
- [lightComplete.md](./lightComplete.md) - `complete` 推荐来源（轻量补全通道）
