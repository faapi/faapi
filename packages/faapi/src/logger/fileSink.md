# fileSink

一句话概括：egg.js 风格的内置文件日志输出——`config.log.dir` 配置一个目录，框架自动把日志条目写入文件（全量文件 + error 独立文件，或按级别分文件），业务方零 sink 代码即得文件日志。

## 为什么需要

`config.log.sink` 接管输出管道能力很强，但写文件这件高频需求（传统部署按文件采集、error 单独告警盘查）要求业务方自己处理目录创建、write stream 生命周期、error 流分离、文本格式——每家写一遍且容易漏（fd 泄漏、流错误未监听导致进程崩溃）。参考 egg-logger 的默认体验（配个 `dir` 即有 `app.log` + `common-error.log`，error 条目自动 dup 到错误文件）内置文件 sink：文本格式复用默认 console 格式（`formatEntry`），一条配置覆盖文件输出 + stdout 双写 + 请求日志并入（见 `logger.md`）。

## 使用场景

```ts
// faapi.config.ts
export default {
  log: {
    dir: 'logs',              // 配置即启用：logs/app.log 全量 + logs/error.log 仅 error
    // splitByLevel: true,    // 改为按级别四文件：logs/debug.log | info.log | warn.log | error.log（各只含对应级别）
    // stdout: true,          // 默认 true：写文件同时保留 console 输出；false 纯文件
    // level: 'debug',        // 显式阈值；不配置时文件管道不过滤（全量落盘，分流由文件布局决定）
  },
} satisfies FaapiConfig;
```

文件布局：

| 配置 | 产出文件 | 内容 |
|------|---------|------|
| `dir`（默认） | `app.log` + `error.log` | app.log 全量条目；error.log 仅 error 级别条目（egg dup 语义，一条 error 两处都有） |
| `dir` + `splitByLevel: true` | `debug.log` / `info.log` / `warn.log` / `error.log` | 各文件只含对应级别的条目 |

## 行为约定

- **目录创建**：`configureLogging` 启动期 `mkdirSync(dir, { recursive: true })`，创建失败抛错（fail fast，不静默降级为丢日志）
- **写入方式**：每文件一个持久 `fs.WriteStream`（`flags: 'a'` 追加），文本行 = 默认 console 格式 + `\n`；异步缓冲（写文件不阻塞请求），进程优雅停机由 Node 退出前 flush，强杀场景尾部可能丢（同 egg-logger 的 stream 行为）
- **流错误吞掉**：stream `error` 事件监听后忽略（磁盘满/权限等）——日志永不影响业务流程，与"日志调用永不抛错"同语义
- **生命周期**：`configureLogging` 每次调用先 `close()` 上一次的文件流（切配置/多 app 后启动覆盖，fd 不泄漏）；`close` 后不再写入
- **与 `sink` 互斥**：`config.log.sink` 与 `config.log.dir` 同时配置启动报错——两个输出管道接管方式二选一，需要"自定义格式 + 文件"时在自定义 sink 里自行写文件

## 相关模块

- `logger.ts` - `configureLogging` 编排文件 sink 的创建与关闭；阈值语义（dir 模式未配 level 不过滤）
- `formatEntry.ts` - 复用默认文本格式化（console 与文件同格式）
- `loggerTypes.ts` - `LogConfig` 的 `dir`/`splitByLevel`/`stdout` 字段声明
- `middleware/logger.ts` - 请求日志并入文件管道（`accessLog` 缺省随 `dir` 启用）
