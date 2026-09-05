---
'@faapi/mcp': patch
'@faapi/schema': patch
---

修复 resource 批量重建的 N+1 广播风暴：

- `mcpServer` 的 `removeResource` / `removeResourceTemplate` 新增 `{ silent: true }` 选项——跳过 `notifications/resources/list_changed` 逐次广播
- `@faapi/schema` 的 schemaServer 资源重建（先清 N 个旧 resource 再注册）改为静默删除、末尾统一广播一次——路由多的项目此前每次 dev reload 会向所有 SSE session 发送 N+1 次相同通知
