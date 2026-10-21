# loggerTypes

一句话概括：日志子系统的类型契约——级别、日志条目、sink、Logger 接口与 `config.log` 配置形状。

## 为什么需要

日志器跨越多条注入路径（handler 的 `ctx.log` / 参数 `log`、任务的 `taskCtx.log`、任意位置的 `createLogger`）与配置入口（`config.log`），类型是各路径形状一致的单一来源；隔离任务经 postMessage 回传的日志条目也以 `LogEntry`（纯数据）为跨线程契约。

## 使用场景

- 业务方：`import type { Logger, LogLevel, LogConfig } from '@faapi/faapi'` 标注自定义 sink 参数、封装日志工具
- 框架内：`createContext`（ctx.log）、`injectParams`（log 注入）、`taskQueue`/`taskWorker`（taskCtx.log 与跨线程桥）、`createServer` 无直接依赖（请求日志中间件是独立管道）

| 类型 | 形状 | 说明 |
|------|------|------|
| `LogLevel` | `'debug' \| 'info' \| 'warn' \| 'error'` | 阈值序 debug < info < warn < error |
| `LogEntry` | `{ level, message, time, scope?, fields? }` | sink 的输入；`time` 为 ISO 字符串；纯数据可结构化克隆 |
| `LogSink` | `(entry: LogEntry) => void` | 输出目标（默认 console 文本，可接 pino/文件） |
| `Logger` | `debug/info/warn/error(message, fields?)` + `child(scope)` | 消息在前、结构化字段可选在后；child 返回新 Logger（scope `:` 合并、fields 浅合并） |
| `CreateLoggerOptions` | `{ level?, sink?, fields? }` | `createLogger` 实例级覆盖（命名避开请求日志中间件先有的 `LoggerOptions`） |
| `LogConfig` | `{ level?, sink? }` | `config.log` 的对象形状（config 侧另接受 `boolean`） |

## 相关模块

- `logger.ts` - 实现类型契约（createLogger/configureLogging/默认 console sink）
- `configTypes.ts` - `log?: LogConfig | boolean` 引用 LogConfig
- `contextTypes.ts` - `FaapiContext.log: Logger`
- `taskTypes.ts` - `TaskContext.log?: Logger`
