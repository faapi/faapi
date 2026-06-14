# sendNodeResponse

一句话概括：将 Response 写入 Node.js ServerResponse。

## 为什么需要

Web 标准 Response 需要写入 Node.js 原生响应对象，包括状态码、headers、body。

## 使用场景

- 发送响应到客户端
- 流式写入 body

## 相关模块

- `toResponse.ts` - 提供 Response
- `createServer.ts` - 调用此函数
