# generateTypes

一句话概括：构建时生成 RPC 类型文件，供前端获得端到端类型安全

## 为什么需要

faapi 的"函数即接口"理念 + 端到端类型安全 = 前后端类型共享

## 使用场景

faapi build --types faapi-types.ts；dev 启动时可选生成

## 相关模块

- `buildCommand.ts` - build 命令入口
- `analyzeInjection.ts` - 提取类型信息
- `startCommand.ts` - dev 启动时可选生成
