---
'@faapi/faapi': patch
'@faapi/mcp': patch
'@faapi/agent': patch
---

框架评估修复批次 4：注册表清理所有权、MCP 定时器泄漏、观测数据修正与会话上限。

**@faapi/faapi**

- **注册表清理所有权守卫**：`app.close()` 此前无条件清空全局 tool/agent/skill 注册表与 agent handle 工厂——同进程多 app 场景（测试/嵌入）下，先创建的 app close 会清掉运行中 app 的注册表。现在仅在自身是当前单例 app 时清理，与单例清理的所有权检查语义对称

**@faapi/mcp**

- **Node 适配器 SSE 断连泄漏修复**：客户端断开后源流不销毁，底层 web ReadableStream 的 `cancel()` 永不触发——SSE 心跳 `setInterval` 持续 enqueue 到无消费者的流（定时器 + 队列持续泄漏）。现在断连时销毁源流并按正常完成收尾（与主包 sendNodeResponse 语义一致）
- **SessionManager 会话数上限**：新增 `sessionMaxSessions` 选项（默认 1000，0 不限），`create` 时超限按 LRU（最久未活动）淘汰并关闭订阅者——防 initialize 洪水在 TTL 窗口内无限堆内存

**@faapi/agent**

- **并行 tool tracing durationMs 失真修复**：结束时间此前在 `Promise.all` 之后的串行循环里统一采集，同轮每个 tool 的 `durationMs` 都包含等待其他 tool 的时间（全部失真为「最慢 tool」耗时）。现在在各自执行闭包内采集，`durationMs` 只反映自身执行耗时
