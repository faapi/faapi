# session

一句话概括：MCP 会话管理（内存 Map，Session ID 生成与查找，TTL 自动过期，SSE 订阅者与日志级别）

## 为什么需要

Streamable HTTP transport 通过 Mcp-Session-Id header 维持会话。会话在 initialize 时创建，在 DELETE 请求时销毁。会话存储客户端信息（clientInfo）、协商的协议版本（protocolVersion）、日志级别和 SSE 订阅者集合。

## 使用场景

- streamableHttp 在 initialize 请求时调 `sessionManager.create()` 创建会话
- 后续请求通过 `Mcp-Session-Id` header 查找会话（`sessionManager.get(id)`）
- DELETE 请求调 `sessionManager.delete(id)` 销毁会话
- GET 请求通过 `addSubscriber(sessionId, controller)` 注册 SSE 订阅者
- mcpServer 的 `handleInitialize` 填充会话的 protocolVersion 和 clientInfo
- mcpServer 的 `logging/setLevel` 修改会话的 loggingLevel
- mcpServer 的 `sendLogging` 通过 `broadcastToSession` 推送日志到订阅者

## 会话生命周期

1. **创建**：transport 层在 initialize 请求时创建（loggingLevel 默认 `info`，subscribers/subscribedResources 为空 Set）
2. **初始化**：客户端发送 `notifications/initialized` 后标记 `initialized = true`
3. **使用**：后续请求通过 session ID 查找会话（每次 get 刷新 lastActivity）
4. **订阅**：GET 请求通过 `addSubscriber` 注册 SSE 流，stream cancel 时 `removeSubscriber` 注销
5. **销毁**：DELETE 请求、TTL 过期或服务端主动关闭——销毁时关闭所有订阅者的 controller

## 会话字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 会话 ID（UUID） |
| `initialized` | boolean | 是否完成 initialize 握手 |
| `protocolVersion` | string | 协商的协议版本 |
| `clientInfo` | `{ name, version }` | 客户端信息 |
| `createdAt` / `lastActivity` | number | 创建/最后活动时间戳 |
| `loggingLevel` | `LoggingLevel` | 当前日志级别(默认 `info`),过滤 `notifications/message` 推送 |
| `subscribers` | `Set<SseSubscriber>` | SSE 流订阅者集合(GET 流注册) |
| `subscribedResources` | `Set<string>` | 已订阅资源 URI 集合(resources/subscribe 注册) |

## TTL 过期机制

会话有空闲超时,默认 30 分钟,可通过 `createMcpServer({ sessionTtl })` 配置(毫秒,设为 0 表示永不过期)。超过 TTL 未活动的会话自动过期：

- `get(id)` 检查是否过期，过期则关闭订阅者、删除并返回 undefined；未过期则刷新 `lastActivity`
- `has(id)` 检查是否过期，过期则关闭订阅者、删除并返回 false（不刷新 lastActivity）
- `create()` 时惰性清理所有过期会话（无需定时器）

这防止了客户端不调 DELETE 导致的内存泄漏。多实例部署需替换为外部存储（如 Redis）实现共享会话和主动过期。

## SSE 订阅者管理

| 方法 | 说明 |
|------|------|
| `addSubscriber(sessionId, controller)` | 注册 SSE 订阅者,返回 `SseSubscriber` 或 undefined(session 不存在) |
| `removeSubscriber(subscriber)` | 注销订阅者(stream cancel 时调用) |
| `broadcastToSession(sessionId, data)` | 向 session 所有订阅者推送 SSE 数据(controller 已关闭的自动移除) |
| `shouldLog(sessionId, level)` | 判断指定级别日志是否应该推送(`>=` session.loggingLevel) |
| `subscribeResource(sessionId, uri)` | 添加资源订阅(uri 加入 subscribedResources) |
| `unsubscribeResource(sessionId, uri)` | 取消资源订阅(uri 从 subscribedResources 移除) |
| `findSubscribersOfUri(uri)` | 找出所有订阅了指定 URI 的 session id 列表 |
| `closeSubscribers(session)` (private) | 关闭 session 所有订阅者(销毁/过期时调用) |

## 全局管理方法

| 方法 | 说明 |
|------|------|
| `size` | getter,返回当前会话数(不含已过期的) |
| `allSessionIds()` | 返回所有未过期会话 ID 数组(mcpServer 的 `broadcastNotificationToAllSessions` 依赖此方法推送全局通知) |
| `clear()` | 清空所有会话,关闭全部订阅者(测试 / 优雅关闭时调用) |

## LoggingLevel

8 个 syslog 严重度级别(从低到高):

```
debug → info → notice → warning → error → critical → alert → emergency
```

`shouldLog(sessionId, level)` 比较 `LOGGING_LEVEL_ORDER[level] >= LOGGING_LEVEL_ORDER[session.loggingLevel]`,低于 session 级别的日志被丢弃。

## 相关模块

- [mcpServer](./mcpServer.md) — 填充会话信息（protocolVersion、clientInfo、initialized、loggingLevel）
- [streamableHttp](./streamableHttp.md) — 创建和销毁会话，注册 SSE 订阅者
