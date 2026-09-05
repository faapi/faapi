---
'@faapi/mcp': patch
---

MCP Streamable HTTP 的 JSON-RPC 批量处理对齐规范并并行化：

- **批内单条无效不再整批 400**：JSON-RPC 2.0 规范要求仅对无效条目生成 `id:null` 的 ParseError 响应，其余条目正常处理。新增 `parseJsonRpcBatch`，解析失败的条目以错误响应形态并入批响应数组；空批保持 400 Invalid Request
- **批内请求并行执行**：此前串行 `await`（一个慢 tool 阻塞同批后续请求），现为 `Promise.all` 并行，响应按请求声明顺序回传（与完成顺序无关）；单个请求的错误由 handleJsonRpc 内部转为 error response，互不影响
