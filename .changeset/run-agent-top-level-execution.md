---
'@faapi/faapi': minor
---

run 型 agent（自定义 run）可用性修复——顶层执行 + 构建期 config 豁免：

- **顶层执行**：`agent.run()` / `stream()` 现在同样执行自定义 `run`（此前仅 sub-agent 派发路径生效，顶层静默走默认 reactLoop、run 被忽略）。入参与 sub-agent 派发统一为单字段 `{ input }`（第二参为完整请求 `FaapiContext`）；返回值规范化为 `ReactLoopResult`（string 直取 content / object 透传补缺省 / 空值空 content）。`stream()` 回退为单 delta + done chunk（run 内为普通代码，无逐 token 可观测性）。`options.messages` 历史续跑对 run 型 agent 显式抛错
- **构建期 config 豁免**：`hasRun=true` 的 agent config 块整体可选——最简 run 型 agent 只导出 `run` 函数；`description` 从 run 导出的 JSDoc 提取（asTool 派发时主控 LLM 的决策依据）。声明式 agent（无 run）行为不变（systemPrompt / systemPromptFile 二选一必填）
- 行为变更说明：此前顶层调用 hasRun agent 会走默认 reactLoop（用 config 的 systemPrompt）——该语义分裂无人依赖，统一为两个入口都执行 run
