---
'@faapi/faapi': minor
---

日志配置收敛为 egg.js 单管道模型——`config.log` 成为唯一日志配置入口，请求日志无条件并入统一管道，废除 `config.logger` 独立配置。

**行为变化（维护者确认按 minor 发布）**：

- **删除 `FaapiConfig.logger` 配置字段与 `CreateServerOptions.logger`/`TestServerOptions.logger` 选项**——`config.logger: false` 改用 `config.log.accessLog: false`；`config.logger: { log }` 自定义输出改用 `middlewares: [logger({ log })]` 自行组装（`logger` 中间件仍从主入口导出）
- **请求日志默认并入统一管道**（原默认 `console.log` 打印对象）——条目转 `LogEntry`（scope `access`，level 按 status 映射 2xx/3xx→info、4xx→warn、5xx→error，fields 携带 requestId/method/path/status/durationMs），与业务日志同文件/同 sink/console 出口；解析旧 `console.log` 对象输出的采集脚本需按新文本格式调整
- **`config.log: false` 语义收严**：请求日志一并静默（原仅静默业务日志、请求日志照常 console.log）
- **`config.log.level` 语义变化**：从"全局唯一阈值（缺省 info）"改为"管道出口阈值（缺省不过滤）"——未配置 level 时 sink/文件收到全量条目（含 debug）；接 pino 的用户若依赖 faapi 侧降噪需显式配置 level 或在 pino 侧过滤

**新能力**：

- `consoleLevel`（新配置字段）：console 出口独立阈值，默认 `'info'`，`false` 关闭 console——与 `level`（文件/sink 出口）互不牵扯，文件可只存 error 而 console 看全（egg transport 模型）
- 请求日志 scope `access` 与业务日志 requestId 关联，dir 文件模式下 5xx 请求自动进 error.log
