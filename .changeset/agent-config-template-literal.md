---
'@faapi/faapi': minor
---

agent config 块字段提取增强：`systemPrompt`/`tools`/`agents`/`model`/`maxTurns` 支持无插值模板字符串（`NoSubstitutionTemplateLiteral`，多行人设的常见写法，语义等价字符串字面量）；声明了字段但值提取失败（变量引用、含插值模板字符串、混合类型数组元素等）时构建期抛 `SchemaExtractionError`（带 file:line:column），不再静默降级为 `undefined` 导致运行时人设丢失无告警。
