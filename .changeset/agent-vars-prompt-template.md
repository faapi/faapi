---
'@faapi/faapi': minor
'@faapi/agent': minor
---

agent config 新增 `vars` 提示词模板变量（静态字面量）：声明后 `systemPrompt` / `systemPromptFile` 内容中的 `{{key}}` 点路径占位符在每次 run 与 sub-agent 派发时按 vars 渲染——同一提示词模板可被多个 agent 复用、各自 config 静态特化。构建期守卫：vars 须为平面对象字面量，叶子仅字符串（含无插值模板字符串与 `+` 拼接）/数字/布尔，嵌套对象、数组、标识符引用、含插值模板字符串构建期抛 `SchemaExtractionError`。缺失或非法占位符运行时抛 `AgentError`（不发起 LLM 请求）；未声明 vars 完全不渲染，存量提示词行为逐字节不变。渲染实现为 `@faapi/agent` 内部模块（不进公开导出面），细则见 `packages/agent/src/promptTemplate.md`。
