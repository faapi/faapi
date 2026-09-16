# logger

一句话概括：请求日志中间件,每请求一条 method/path/status/duration,默认启用并**无条件并入统一日志管道**（egg 模型:访问日志与业务日志同管道）

## 为什么需要

生产环境排查问题需要请求日志。框架默认启用 logger,请求条目转 `LogEntry`（scope `access`）经 `writeLogEntry` 走统一管道——与业务日志同文件/同 sink/console,一份 `config.log` 管全部输出,无需第二份日志配置。`config.logger` 独立配置已废除（major: 单一入口简化）。

## 使用场景

作为洋葱模型中间件使用,在 `await next()` 前后记录日志。前记录 method/path,后追加 status/duration。

条目形状（并入管道后）:

- `level`: 按 status 映射——2xx/3xx → `info`、4xx → `warn`、5xx → `error`(文件模式下 5xx 自动进 error.log)
- `message`: 文本 `GET /api/users 200 12ms`(错误为 `POST /api/users 400 45ms - Error: ...`)
- `scope`: `access`(与业务日志的 `http` 区分,`requestId` 关联两者)
- `fields`: `{ requestId, method, path, status, durationMs, error? }`

### 配置(全部在 `config.log`,无独立请求日志配置)

- 缺省: 并入管道(文件模式下落文件 + console 双写;纯 console 模式经 console 出口输出)
- `config.log.accessLog: false`: 关闭请求日志(不输出)
- `config.log: false`: 全静默,请求日志一并关闭

### 编程式自定义输出(高级)

`logger` 中间件仍从主入口导出,需要完全接管输出时自行组装:

```ts
// faapi.config.ts
import { logger } from '@faapi/faapi';

export default {
  middlewares: [logger({ log: (entry, msg) => pinoLogger.info(entry, msg) })],
} satisfies FaapiConfig;
```

显式 `options.log` 时完全接管,不再走统一管道。

## 中间件顺序

CORS → helmet → **logger** → 全局中间件 → routePipeline（含目录中间件 + handler）

logger 放在 helmet 之后、全局中间件之前,记录"业务请求总时长"（含全局中间件 + handler）。CORS 必须最外层（处理 OPTIONS 预检,预检请求不进入 logger）。

## 相关模块

- `middlewareTypes.ts` - 实现中间件接口
- `invokeHandler.ts` - 中间件执行入口
- `createServer.ts` - 在中间件链中注册 logger（默认挂载）
- `../logger/logger.ts` - `isAccessLogEnabled` / `writeLogEntry`（并入输出）
- `../logger/logger.md` - 统一管道配置（`config.log` 唯一入口）
- `configTypes.ts` - `log?: LogConfig | boolean` 配置项
