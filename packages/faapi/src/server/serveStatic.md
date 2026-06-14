# serveStatic

一句话概括：静态文件服务，支持 MIME 类型映射和路径遍历防护

## 为什么需要

API 服务通常也需要托管前端静态资源

## 使用场景

通过 --static public 启用；路由未匹配时尝试提供静态文件

## 相关模块

- `createServer.ts` - 注册静态文件处理
- `parseArgs.ts` - 解析 --static 命令行参数
