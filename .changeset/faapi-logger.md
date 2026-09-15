---
'@faapi/faapi': minor
---

feat(logger): 新增框架级业务日志器——级别、scope 分类、结构化字段、可插拔 sink

参考 NestJS（级别过滤 / context 分类 / 自定义实现替换）与 Fastify（请求级 child logger 绑定 requestId）补齐业务侧日志能力，与既有请求日志中间件（`config.logger`）并行、互不影响：

- 新增 `createLogger(scope?, options?)` / `configureLogging()` 公开导出（`Logger`/`LogLevel`/`LogEntry`/`LogSink`/`LogConfig`/`CreateLoggerOptions` 类型）：`debug/info/warn/error(message, fields?)` + `child(scope)`；默认 console 文本输出，`sink` 可整体接管（接 pino/winston/文件），零新增依赖
- `FaapiContext` 新增 `requestId`（`x-request-id` 头优先，否则 UUID 生成）与 `ctx.log`（scope `http`，自动携带 requestId/method/path 字段）；新增内置参数注入名 `log`（与 `ctx.log` 同一实例）
- 任务 `TaskContext` 新增可选 `log`（scope `task:<name>`，字段 jobId/task/attempt）；隔离执行任务经 postMessage 回传宿主统一输出，自定义 sink 同样覆盖
- 新增 `config.log` 配置（`LogConfig | boolean`）：级别解析 `config.log.level` > `LOG_LEVEL` 环境变量 > `'info'`（非法值启动报错）；`log: false` 完全静默；请求日志中间件结构化条目附带 `requestId` 字段（文本格式不变，零破坏）
