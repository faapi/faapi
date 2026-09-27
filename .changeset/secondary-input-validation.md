---
'@faapi/faapi': minor
---

次输入「声明即校验」接线：方法主输入之外显式声明的输入此前完全绕过 schema——POST/PUT/PATCH handler 声明 `query` 形参拿到的一直是 URL 原始字符串（`query: { page: number }` 实际收到 `'2'`，与 DB 值或数字做严格比较即静默出错）；DELETE handler 声明 `body` 则完全无校验（声明 `number[]` 传字符串也 200 直达 handler，Date 字段保持 ISO 字符串、与 POST body 行为不一致）。

本次补齐：

- **body 方法的 query 声明**：按方法生成 `<METHOD>Query` schema（如 POSTQuery，`Query` 后缀自动 coerce），请求管线校验（不匹配 422）并把 coerce 后的值挂载 `__validatedQuery`——handler 的 query 注入优先取用（声明字段拿到转换值，未声明字段保留原始字符串）。未声明 query 形参行为不变（回退原始字符串）。
- **DELETE 的 body/form 声明**：生成 `<METHOD>Body` schema（如 DELETEBody；form 共享 Body 名、coerce=true），解析后校验再注入——非法 payload 422（此前无条件放行），Date 字段与 POST body 一致转换为 Date 对象（响应序列化仍为毫秒时间戳）。空请求体（undefined）跳过校验，行为不变。
- GET/HEAD 声明 body 不生成 schema（注入恒为 undefined，该声明属无效标注）。

**升级注意**：依赖「POST query 拿字符串」「DELETE body 不校验」旧行为的代码会开始拿到转换值 / 收到 422——这是声明应有的语义。WS 握手的 params/query 保持原始字符串（WS 无 schema 管线，设计边界已在 AGENTS.md 5.9 明示）。
