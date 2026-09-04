---
'@faapi/faapi': patch
'@faapi/mcp': patch
'@faapi/agent': patch
---

修复三处正确性问题：

- **@faapi/faapi**：`interface extends` 继承不再抛 SchemaExtractionError（heritage 节点此前未接入解析链，与文档承诺不符）；同时新增泛型类型支持——泛型 interface / type 别名按位置绑定类型实参（`Box<string>`）、支持默认类型形参（`<T = string>`）、泛型形参遮蔽同名真实类型，实参缺失且无默认时显式抛错
- **@faapi/mcp**：GET SSE 心跳 tick 续期 session（`SessionManager.touch`），只收推送不发请求的客户端不再因空闲 TTL 被 30 分钟强制断开；携带无效/已过期 `Mcp-Session-Id` 的 GET 请求改为返回 404（MCP 规范），客户端可据此重新 initialize 而非静默空转
- **@faapi/agent**：OpenAI provider 的 SSE 解析兼容 CRLF / CR 行尾（SSE 规范允许），使用 CRLF 行尾的 OpenAI 兼容网关此前流式输出完全失效（事件无法切分、`[DONE]` 识别失败）
