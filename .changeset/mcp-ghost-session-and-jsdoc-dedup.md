---
'@faapi/mcp': patch
'@faapi/faapi': patch
---

- **@faapi/mcp**：过期 session 不再参与广播与查询——`broadcastToSession` 对目标会话做过期检查（过期即清扫并关闭订阅者，不投递），`allSessionIds` / `findSubscribersOfUri` 遍历前清扫过期会话。长时间无新 `initialize` 的服务此前会累积幽灵 session（常驻内存、持续接收广播的空转 enqueue），现在广播/查询路径惰性清除
- **@faapi/faapi**：内部重构——`extractToolMetadata` / `extractAgentMetadata` 的 JSDoc 工具函数（`hasExportModifier` / `getJSDocFromNode` / `extractDescription` / `@tag` 覆盖名提取）统一到 `jsDocMetadata` 模块，消除逐字重复
