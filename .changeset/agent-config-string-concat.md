---
'@faapi/faapi': minor
---

agent config 字段支持字符串字面量的 `+` 拼接静态求值：`systemPrompt` / `model` 及 `tools` / `agents` 数组元素接受 `'字面量' + '字面量'`（含多段链式与多行写法），提取结果与 JS 运行时拼接语义一致。此前该写法在构建期报 `SchemaExtractionError`（5.0.1 及更早版本则静默丢失字段）。拼接中混入变量引用、含插值模板字符串或数字仍报错；报错文案同步更新，说明支持拼接写法。
