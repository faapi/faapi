---
'@faapi/faapi': patch
---

框架评估修复批次 2：HTTP 语义补齐、优雅停机、性能与产物一致性。

- **HEAD 回退 GET**：无显式 HEAD 路由时复用 GET handler（Node 自动丢弃 body）。探活、CDN 健康检查、HTTP 客户端预检常用 HEAD——此前只定义 GET 的路由对 HEAD 返回 405，监控大面积误报。`findAllowedMethods` 在 GET 允许时把 HEAD 加入 Allow 头（RFC 9110）
- **默认优雅停机**：`listen()` 现在默认注册 SIGTERM/SIGINT 处理（进程级仅一次），收到信号走 `app.close()`（drain 在途请求 + `onClose` 钩子 + 注册表清理）后退出——此前仅在配置了 `onClose` 时注册。`close()` 从"立即 `closeAllConnections` 硬关"改为 drain 语义：断开空闲 keep-alive → 等在途请求完成 → SSE/WS 长连接超时（`FAAPI_SHUTDOWN_TIMEOUT_MS`，默认 10s）后强制断开。滚动部署不再硬断连接
- **query 重复 key 聚合为数组**：`?tag=a&tag=b` 现在得 `{ tag: ['a', 'b'] }`（对齐 Express qs / Hono getAll）——此前 last-wins 静默丢弃，声明 `string[]` 的 query 字段永远校验失败（解析端从未产出数组）。单值字段行为不变
- **dev 按需 Program 缓存按 tsconfig 共享**：共享缓存 key 此前含文件列表，每个路由文件各自持有一份全项目 TS Program（内存 O(路由数 × 项目大小)，无淘汰）；现在同一 tsconfig 只建一份 Program，通过 `getSourceFile` 校验覆盖全部入口
- **产物原子写**：zod.js、faapi-routes.js、faapi-tools.js、faapi-agents.js、faapi-helpers.js 统一改为 tmp+rename 原子写（新增 `utils/atomicWrite`）——dev watch 重建与在途请求并发时，请求不会再 import 到截断的半成品产物
- **`formatErrorResponse` 不再就地改写业务方 `response.fail` 返回对象**：issues 附加改为浅拷贝扩展，业务方复用/冻结 fail 返回对象不再引发跨请求污染或静默失败
- **rebuildScheduler 待编译文件去重**：编辑器连续保存触发的多次 change 事件不再导致同一文件在同一轮重复编译
- **readTsconfig 按 mtime 缓存**：watcher 每轮重建、每次首请求按需编译都会读 tsconfig，Compiler API 解析（含 extends 链合并）结果按 mtime 缓存，tsconfig 变化自动失效
