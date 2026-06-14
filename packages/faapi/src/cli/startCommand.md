# startCommand

一句话概括：CLI 启动命令的完整流程。

## 为什么需要

串联参数解析、路由扫描、服务启动的完整流程，是 CLI 的核心入口。

## 使用场景

- CLI 入口调用
- 串联各模块完成启动

## 相关模块

- `parseArgs.ts` - 解析参数
- `scanRoutes.ts` - 扫描路由
- `startServer.ts` - 启动服务
