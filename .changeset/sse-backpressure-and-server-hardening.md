---
'@faapi/faapi': minor
---

SSE 背压感知 + 服务器/中间件健壮性批次：

- **SSE 背压**：`SseWriter` 新增 `desiredSize`（透传 `controller.desiredSize`，`null` = 已关闭/断开）与 `waitForDrain()`（缓冲超高水位时挂起，消费者拉取/流关闭/客户端断开时返回）；流设显式高水位 16 chunk。`send`/`sendRaw` 同步签名不变——快生产者（LLM token 流）+ 慢客户端此前会让缓冲无界增长（每连接一处内存泄漏点），生产循环现在可感知并暂停
- **WS 用户回调异常隔离**：`onOpen`/`onMessage`/`onClose` 抛错被框架捕获，故障半径限定当前连接——有 `onError` 时转交业务方（可 `ws.close()` 自决），无 `onError` 时 `console.error`；`onError` 自身抛错同样捕获。此前 EventEmitter 监听器同步抛出会沿 emit 传播成 uncaughtException（Node 15+ 默认终止进程），一条消息里的 `JSON.parse` 抛错等于 `process.exit`
- **413 连接处理**：请求体超限响应附 `Connection: close` 并在写出后销毁请求连接——此前请求流既未消费也未断开，keep-alive 连接无法复用，客户端上传只会收到晦涩的连接重置
- **请求管线兜底留痕**：最外层 catch（`sendErrorResponse` 自身失败的极端场景）此前静默吞错，现 `console.error` 留痕并对 headers 已发场景安全收尾
- **按需编译 mutex 错误传播**：并发等待方原样重抛首个触发方的真实编译/生成错误——此前吞错返回 false，调用方去 import 不存在的产物，报误导性的 `ERR_MODULE_NOT_FOUND` 掩盖真实编译错误
- **CORS Vary 合并修复**：动态 origin 下的 `Vary: Origin` 改从权威来源 meta.headers 合并（新增共享 `mergeVary`，与 compression 的 `Accept-Encoding` 同一实现）——此前读请求头，既看不到其他中间件已设置的响应 Vary（会被覆盖），客户端伪造的 Vary 请求头还会被带进响应
- **性能**：请求管线合并注入器按 route WeakMap 缓存（不再每请求 spread 重建）；`queryToObject` 按实例缓存（GET 请求每请求两次 query 解析降为一次）
- **内部清理**：删除从未导出的 `startServer()` 死代码（与 createServer 的功能子集漂移、listen 无 reject 与 error 监听），保留 `applyPluginWrappers`（文件名为历史路径，公开 API 无变化）
