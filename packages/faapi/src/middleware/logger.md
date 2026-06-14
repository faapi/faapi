# logger

一句话概括：请求日志中间件，输出 method path status duration

## 为什么需要

生产环境排查问题需要请求日志

## 使用场景

作为 before+after+error 中间件使用；支持自定义 log 函数

## 相关模块

- `middlewareTypes.ts` - 实现中间件接口
- `invokeHandler.ts` - 中间件执行入口
