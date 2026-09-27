---
'@faapi/faapi': minor
---

路由参数按声明类型接线：路径参数与 query 注入此前一直是 URL 原始字符串，schema 的 coerce 结果只用于校验门禁、从未传给 handler——声明 `id: number` 实际拿到 `'1'`，handler 侧与 DB 值做严格比较即恒不等（真实案例：业务路由 `chapter.novelId !== params.id` 数字比字符串恒真，无条件 404）。

本次补齐设计早已预留的接线：

- **路径参数**：handler 声明 `params: XxxParams` 时按方法生成 `<METHOD>Params` schema（GETParams/POSTParams/...），请求管线校验（不匹配 422，此前路径参数完全无校验）并把 coerce 后的值回写 `ctx.params`——handler 注入、中间件与诊断日志拿到的都是转换后的值；以原始 params 打底合并，catch-all 等声明之外的段不被 z.object 剥掉。未声明 `params` 类型的路由无 schema，保持原始字符串。
- **query（GET/DELETE/HEAD 主输入）**：schema 解析后的值挂载为校验产物并优先注入 handler（声明 `page: number` 拿到数字，与 route.md 既有承诺一致）；同样以原始 query 打底，声明之外的字段保留原始字符串。无声明路由行为不变。
- `FaapiContext.params` 类型放宽为 `Record<string, string | number | boolean>`（转换后路径参数可含 number/boolean）。

**升级注意**：此前在 handler 里自行 `Number(params.id)` 转换的代码不受影响；但依赖「声明了 number 却拿到字符串」的代码（如 `query.page === '1'` 之类比较）会开始拿到真正的 number——这正是声明应有的语义。
