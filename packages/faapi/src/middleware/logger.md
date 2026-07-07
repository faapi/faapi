# logger

一句话概括：请求日志中间件,输出 method path status duration,默认启用（与 cors 一致）

## 为什么需要

生产环境排查问题需要请求日志。框架默认启用 logger,确保零配置即有日志输出;用户可通过 `faapi.config.ts` 的 `logger` 字段自定义或关闭。

## 使用场景

作为洋葱模型中间件使用,在 `await next()` 前后记录日志；支持自定义 log 函数。前记录 method/path,后追加 status/duration。

通过 `faapi.config.ts` 的 `logger` 字段配置:

- `undefined` / `true` → 启用默认 logger()（console.log）
- `false` → 禁用内置 logger
- `LoggerOptions` → 启用并自定义（如传入 pino/winston logger 实例）

```ts
// faapi.config.ts
export default {
  // 默认启用,无需配置
  // 或精细配置
  logger: {
    log: (obj, msg) => pinoLogger.info(obj, msg),  // 结构化日志
  },
  // 或关闭
  logger: false,
} satisfies FaapiConfig;
```

**完全自定义日志中间件**：`logger: false` + `middlewares: [myCustomLogger]`。

## 中间件顺序

CORS → helmet → **logger** → 全局中间件 → routePipeline（含目录中间件 + handler）

logger 放在 helmet 之后、全局中间件之前,记录"业务请求总时长"（含全局中间件 + handler）。CORS 必须最外层（处理 OPTIONS 预检,预检请求不进入 logger）。

## 相关模块

- `middlewareTypes.ts` - 实现中间件接口
- `invokeHandler.ts` - 中间件执行入口
- `createServer.ts` - 在中间件链中注册 logger（`configMiddlewares.push(logger(opts))`）
- `configTypes.ts` - `logger?: LoggerOptions | boolean` 配置项
