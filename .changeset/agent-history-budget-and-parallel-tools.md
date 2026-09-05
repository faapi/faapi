---
'@faapi/agent': minor
'@faapi/faapi': minor
---

agent 循环可靠性两项改进：

- **历史 token 预算（`maxHistoryTokens`）**：多轮 tool 循环中对话历史只增不减，大 tool 结果会把发给 LLM 的消息撑爆上下文窗口导致下一轮 400、整个 run 失败。现在可配置 token 预算（近似估算），超预算时从最旧的「轮组」（assistant + 其后全部 tool 结果）开始裁剪——system 与初始 user 永不裁剪、tool 配对不拆散、至少保留最近一轮；裁剪只作用于发给 LLM 的消息副本，本地历史与 trace 不受影响。非流式与流式一致。被裁掉的旧轮不生成摘要（compaction 属后续能力）
- **同轮多 tool_call 并行执行**（非流式路径）：LLM 一轮返回多个 tool_call 时从串行改为 `Promise.all` 并行，总耗时从各 tool 之和降为最慢一个。结果仍按 toolCalls 声明顺序回传（与完成顺序无关）、单个 tool 失败不影响其余；`beforeToolCall`/`afterToolCall` 钩子会并发触发（业务方钩子不应依赖调用顺序）；流式路径保持串行（yield 顺序受消费端约束）
- `config.agent.maxHistoryTokens`（faapi 配置面）同步新增，plugin 转发至 reactLoop
