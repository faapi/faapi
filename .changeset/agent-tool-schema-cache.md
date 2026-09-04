---
'@faapi/faapi': minor
'@faapi/agent': patch
---

`@faapi/agent` 性能优化：tool schema 解析新增跨请求缓存。此前 Agent 工厂每请求构造新实例，每个请求都重新执行 `loadToolSchema`（dynamic import）+ `z.toJSONSchema`（CPU 密集）；现在 setup 闭包级缓存解析结果，按 zod.js 路径 + inputTypeName 作键、文件 mtime 自校验失效（dev `reloadTools` 重生成后自愈，prod 永远命中），并发请求共享同一次解析。高 QPS agent 端点每请求省去 schema 重复解析开销。

`@faapi/faapi` 新增 `getToolSchemaPath(tool, rootDir?)` 公开导出（计算 tool 的 zod.js 绝对路径，纯路径计算），与 `loadToolSchema` 共享 dist 解析逻辑。
