---
'@faapi/faapi': minor
---

日志子系统新增 egg 风格文件输出与请求日志统一管道（`config.log` 新增 `dir` / `splitByLevel` / `stdout` / `accessLog` 字段，公开导出 `flushLogging`）：

- **`config.log.dir`（egg.js 风格文件日志）**：配置目录即启用内置文件管道——默认 `app.log` 全量 + `error.log` 仅 error（dup 语义，一条 error 两处都有）；`splitByLevel: true` 改为按级别四文件 `debug.log` / `info.log` / `warn.log` / `error.log`（各只含对应级别）；`stdout`（默认 `true`）控制是否保留 console 双写。目录启动期自动递归创建（失败抛错），写入走持久 WriteStream 异步缓冲，流错误吞掉不影响业务
- **文件模式默认无阈值**：`dir` 模式未显式配置 `level`（含 `LOG_LEVEL`）时不过滤——全量条目落盘，debug/info/warn/error 的分流由文件布局承担；显式配置时阈值照常生效。console / 自定义 sink 模式默认仍为 `info`（行为不变）
- **请求日志并入统一管道**：`config.log.accessLog` 控制请求日志中间件输出目标（缺省随 `dir` 启用）——并入时条目转 `LogEntry`（level 按 status 映射 2xx/3xx→info、4xx→warn、5xx→error，scope `access`，fields 携带 requestId/method/path/status/durationMs）与业务日志同文件/同 sink，一份配置管全部输出；`{ sink }` 模式缺省不并入（默认 `console.log` 行为不变），显式 `accessLog: true` 开启；`config.logger: { log }` 显式接管优先级最高
- **`flushLogging()`（新公开导出）**：刷盘文件日志缓冲，`lifecycle.onClose` 优雅停机时调用确保落盘
- 其余：`sink` 与 `dir` 互斥（同时配置启动报错）；`config.log: false` 语义不变（业务日志全静默，请求日志需 `config.logger: false` 单独关闭）；任务隔离执行的日志级别快照支持"不过滤"（`getEffectiveLogLevel` 返回 `undefined` 时 worker 侧放行全量）
