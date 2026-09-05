---
'@faapi/faapi': patch
---

框架评估修复批次 6：低影响性能微优化与诊断增强。

- **响应头零重建**：仅 headers 型 meta（helmet 开启后每请求 ~13 个静态头）此前导致 `ctx.ok()` / `ctx.fail()` / 中间件返回的 Response 每请求经历 `new Headers()` 拷贝 + `new Response()` 重建；现在延迟到 Node 发送层一次性 `setHeader`（`pendingMeta` 通道，WeakMap 弱键），compression / etag 重建路径自动搬运
- **动态路由 pattern 预编译**：模式段 split 此前每请求对每条动态路由重复执行，现在索引构建期一次性预编译（`DynamicEntry.segments`）
- **路由派生路径缓存**：每请求的 `path.resolve`（handler 绝对路径）与 `getRuntimeSchemaPath` 字符串运算按 route 对象 WeakMap 缓存（清单替换自动失效）
- **空白 body 判空**：`text.trim() === ''` 的全量字符串拷贝改为 length 短路 + 正则扫描
- **目录中间件首载 in-flight 去重**：冷启动并发首请求对同一 middlewares.ts 不再重复 import + 合并（对照 compileOnDemand 的 mutex 模式）
- **SchemaExtractionError 带 file:line:column**：不支持语法 / 方法签名 / 交叉冲突等抛错点经 `SchemaExtractionError.at(node)` 携带精确源码位置，几百行类型文件不再靠肉眼定位
- **coerceBoolean 大小写不敏感**：`"True"` / `"TRUE"` 现可正确转换（对齐 HTML 表单习惯）
- **build 检查 CJS 项目**：package.json 缺 `"type": "module"` 时构建告警（产物为 ESM，`node dist/main` 否则报难以关联的语法错误）
