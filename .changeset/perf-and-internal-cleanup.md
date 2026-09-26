---
'@faapi/faapi': patch
---

内部质量与性能收尾批次（无公开 API 变化，行为语义不变）：

- **路由匹配**：动态路由匹配时请求路径由「每条候选路由 split 一次」改为「循环外 split 一次传入」（N 条动态路由场景省 N-1 次重复分割；纯静态清单连 split 也不再做）
- **响应发送**：缓冲型 body（string/Buffer——绝大多数 JSON 响应）的 Response 在构造点标记，发送层整体读出后 `res.end` 直写，免掉 `Readable.fromWeb + pipe` 全套流机器；SSE 等活跃流保持 pipe 流式语义（标记机制见 `response/bufferedBody.ts`）
- **请求管线**：合并注入器按 route WeakMap 缓存（对固定 route 恒定，不再每请求 spread 重建）
- **内部收敛**：`invokeHandler` 无中间件/有中间件两份相同执行尾部合并；`formatErrorResponse` 四个同构 fail 分支收敛为 `buildFailBody` 单一实现；路由冲突检测统一为 `reportRouteConflicts`（dev/build 打印格式一致）；产物新鲜度判断收敛为 `isProductFresh` 单一实现（loadPlugins 不再持有语义相同的本地副本）
- **zod 产物管线**：routes/tools/tasks 三份复制粘贴的「分组 → helpers 路径 → 生成 → helpers 按需生成 → 并行原子写」收敛为共享的 `generateZodArtifacts` 管线（差异只剩每文件源码生成回调），helpers 生成语义统一为「已存在跳过」
- **模块拆分**：`createAppCore.ts`（822 行）拆出 `appSingleton.ts`（单例 + 停机信号）、`manifestLoader.ts`（清单装载）、`injectMock.ts`（`app.inject()` mock 传输层），createAppCore 保留编排主流程并 re-export 全部公开导出——公开 API 路径不变
- **logger**：修复 `close()` 与 `write()` 的竞态窗口（end 已调用但流 Map 未清空的间隙里写入会 ERR_STREAM_WRITE_AFTER_END 被吞、条目静默丢失）；关闭标志 + Map 立即清空
- **工程**：根 `typecheck` script 加 `--no-bail`（失败时看到全部包的报错而非首个短路）；mcp/next 包补 `sideEffects: false`；清理 mcp/schema vitest 配置的未使用变量
