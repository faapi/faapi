# cors

一句话概括：CORS 中间件工厂函数，dev 模式自动启用

## 为什么需要

前端跨域请求需要 CORS 头，没有 CORS 前端调用 API 直接失败

## 使用场景

dev 模式自动启用；生产环境通过 --cors 或代码配置

## 相关模块

- `middlewareTypes.ts` - 实现中间件接口
- `createServer.ts` - 注册中间件到服务
- `parseArgs.ts` - 解析 --cors 命令行参数
