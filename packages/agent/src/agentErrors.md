# agentErrors

一句话概括：Agent 系统级错误家族（`AgentError` / `AgentToolTimeoutError` / `AgentRecursionError`）的持有模块。

## 为什么需要

reactLoop（历史压缩不变量守卫，见 [historyCompaction.md](./historyCompaction.md)）需要抛 `AgentError`，而 reactLoop 与 agent.ts 互相依赖（agent.ts 组装并调 reactLoop）——错误类若留在 agent.ts 会形成模块循环依赖。错误类无任何本地依赖，下沉独立模块即解开环。

## 使用场景

- 业务方 `instanceof AgentError` 判定不可恢复错误——**导入路径不变**：三个类经 agent.ts re-export，`import { AgentError } from '@faapi/agent'` 照常工作
- reactLoop / historyCompaction / agent 内部直接从本模块导入

## 相关模块

- `agent.ts` - re-export 三个类（公开 API 零变化）+ 抛出方
- `reactLoop.ts` / `historyCompaction.ts` - 不变量守卫抛 `AgentError`
