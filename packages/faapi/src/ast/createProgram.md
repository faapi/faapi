# createProgram

一句话概括：创建 TypeScript Program 用于 AST 分析,带模块缓存。

## 为什么需要

参数校验需要分析 TypeScript interface 定义,需要创建 TS Program 来访问 AST。Program 创建开销大,故按文件路径缓存。

## 导出

| 函数 | 说明 |
|------|------|
| `createProgram(file)` | 创建 Program（命中缓存直接返回） |
| `invalidateProgramCache()` | 清空 Program 缓存（dev watch 时调用,确保增量编译后读到最新 Program） |

## 使用场景

- 启动时为每个 handler.ts 创建 Program 提取类型
- dev watch 文件变化时,先 `invalidateProgramCache()` 再重新提取

## 相关模块

- `extractHandlerTypes.ts` - 使用 Program 提取类型
- `../cli/devCommand.ts` - watch 时调 `invalidateProgramCache`
- `../cli/buildCommand.ts` - 构建时调 `createProgram`
