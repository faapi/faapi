# sendNodeResponse

一句话概括：将 Response 写入 Node.js ServerResponse。

## 为什么需要

Web 标准 Response 需要写入 Node.js 原生响应对象，包括状态码、headers、body。

## 使用场景

- 发送响应到客户端
- 流式写入 body

## 断连语义

客户端中断（res `'error'` 或提前 `'close'`，即 close 时 `writableEnded === false`）时：

- 销毁源流（`nodeStream.destroy()`）——底层 web ReadableStream 触发 `cancel()`，
  上游生产者（如 SseWriter）感知 `aborted` 停止推送，避免数据持续堆积在无消费者
  的流 buffer（内存泄漏，LLM 流式输出场景尤其致命）
- Promise 按**正常完成** resolve——网络中断不是服务端错误，`handleRequest` 的 catch
  通过 `res.destroyed || res.writableEnded` 判断后跳过 500 兜底与 onError 副作用

源流自身错误（handler 流式写失败等）仍 reject，由调用方走错误响应路径。

## 相关模块

- `toResponse.ts` - 提供 Response
- `createServer.ts` - 调用此函数
