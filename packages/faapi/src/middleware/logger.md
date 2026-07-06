# logger

一句话概括：请求日志中间件,输出 method path status duration

## 为什么需要

生产环境排查问题需要请求日志

## 使用场景

作为洋葱模型中间件使用,在 `await next()` 前后记录日志；支持自定义 log 函数。前记录 method/path,后追加 status/duration。

## 相关模块

- `middlewareTypes.ts` - 实现中间件接口
- `invokeHandler.ts` - 中间件执行入口
