# index (CLI)

一句话概括：CLI 入口脚本。

## 为什么需要

作为 `faapi` 命令的入口点，接收命令行参数，调用启动命令，处理顶层错误。

## 使用场景

- 用户执行 `faapi` 命令
- Node.js 解析 shebang 执行

## 相关模块

- `startCommand.ts` - 执行启动逻辑
