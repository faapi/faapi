---
'@faapi/faapi': minor
'@faapi/agent': minor
---

`agent:root-input` 写面收敛为 `addInput`——实现与 `agent:input` 复用同一条落账管道，loop 首轮两路片段共用暂存、一起合并：

> 版本策略留痕：本变更按语义属破坏性（公开载荷 `AgentRootInputEvent.input` 由可写改为只读——`e.input = …` 的 TS 代码编译错、运行时抛迁移错误），沿 7.9.0 / 7.10.0 / 7.11.0 先例、经维护者指示（2026-10-27 会话）以 minor 随 7.x 线发布——迁移说明见文末。

- **事件保留**：`agent:root-input` / `agent:root-input:<agentName>` 仍是独立事件（一次对话只发一次、对非空 input 触发、按 agent 专属名路由，订阅端无需判首轮）。root-input 本质是「loop 首个用户输入那一轮」的 input，故不再维护第二套改写语义，实现复用 `agent:input`。
- **写面只有 `addInput(text, index = 100)`**：载荷 `input` 变为只读（首条 user 输入原文），赋值抛 `AgentError` 迁移错误。原「整体替换输入」及其扇出后非空校验一并移除——**原输入恒在首条 user 消息中**（可包裹 / 重排，不可丢弃或改写原文，显式声明的能力边界）；输入非空由 `agent.run/stream` 入口守卫承担。
- **首轮共用暂存、一起合并**：root-input 片段在循环启动前暂存（`ReactLoopConfig.appEvent.rootInputStaging`），loop 首轮 `agent:input` 直接复用同一暂存数组续接片段（seq 连续），扇出结束后一次排序（`(index, seq)` 升序——同 index 下 root-input 片段在前）/ 空白过滤 / `'\n\n'` 拼接 / `{{rawInput}}` 展开，落账为**一条**首条 user 消息；root 暂存只在首轮消费，工具轮 / 后续轮不参与。
- 错误口径不变：handler 抛错在循环启动前上抛（depth=1 走 run/stream 错误链；depth≥2 回灌主控 LLM），片段未落账、历史零污染。

迁移指引（`e.input = f(e.input)` → `e.addInput(f('{{rawInput}}'))`，占位符处嵌原输入、不再缀尾）：

```ts
// 旧（7.12 及以前）
app.on('agent:root-input', (e) => {
  e.input = `[tenant:x] ${e.input}`;
});
// 新
app.on('agent:root-input', (e) => {
  e.addInput('[tenant:x] {{rawInput}}');
});

// 闭合包裹（块在前、输入收尾）同样一条片段：
app.on('agent:root-input:chapter-writer', async (e) => {
  const blocks = await buildContextBlocks(e.input, e.ctx.currentUserId);
  e.addInput([...blocks, '<user_input>\n{{rawInput}}\n</user_input>'].join('\n\n'));
});
```

子代理派发（`agent:root-input:<subName>`）同口径迁移；原依赖「整体替换输入、丢弃原文」的写法不再支持。
