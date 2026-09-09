---
'@faapi/faapi': minor
---

agent 构建期校验收紧：不如预期的声明直接报错，不再静默忽略。新增拦截场景：config 声明未知字段（如 `maxTurn` 拼写错误）、config 用不支持的属性形式（shorthand/方法/getter/computed 名）、config 导出形式不支持（`export const config = someVar` 等非对象字面量，错误提示与"未声明 config"区分）、agent 源文件不在 Program（原静默跳过导致 agent 从清单无声消失）、agent 名重复（目录推导名或 `@agent` 覆盖名撞名，原水合时静默后者覆盖前者）、`agents` 引用清单中不存在的 agent 名（原推迟到运行时首次 sub-agent 调用才失败）。`tools` 引用不做构建期校验（业务方 plugin 可运行时注册额外 tool，避免误报）。注意：存量 config 中写了框架不读字段的 agent 升级后构建会失败，需删除或更正字段名。
