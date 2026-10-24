# taskToolContext

一句话概括：`createTaskToolContext` 把任务执行的 carry 快照与任务级能力（scoped TaskClient / 任务级 logger / job.signal）合成为契约形态的 `AgentToolContext`——进程内 `taskCtx.agent` 与隔离任务宿主侧工具执行器共用同一配方。

## 为什么需要

任务路径没有 HTTP 请求，tool ctx 的来源是 enqueue 时声明的 carry（身份/标记纯数据）+ 任务执行现场的任务级能力。合成配方在两处消费：进程内任务的 `taskCtx.agent` 惰性通道、隔离任务的宿主侧工具执行 RPC——配方必须单一维护，否则两条路径的 ctx 形态漂移（契约字段被 carry 覆盖、字段遗漏）都是静默契约破坏。

## 使用场景

- `taskQueue.ts` 进程内任务：`taskCtx.agent` 首次访问时经 agentHandle 工厂构造 Agent
- `taskQueue.ts` 隔离任务宿主侧：工具执行 / 钩子 RPC 的执行 ctx（与进程内同配方）

## 合成规则

```
{ ...carry, tasks, log, signal }
```

- **carry 数据字段落顶层**——身份在 enqueue 处声明一次（`carry: { currentUserId }`），工具按增强字段直读，与 HTTP 路径中间件塞 ctx 的形态一致
- **契约字段后置展开**——carry 不可覆盖 tasks/log/signal（框架保证不被业务数据污染）
- carry 为纯数据（enqueue 时已校验可结构化克隆），合成结果天然满足隔离路径的 postMessage 边界（宿主侧合成、不跨线程）

## 相关模块

- `../runtime/agentToolContext.ts` - 契约类型定义与三路径填充规则
- `./taskTypes.ts` - `TaskContext.carry`（enqueue 携带的执行上下文快照）
- `./taskWorker.ts` / `../cli` 下 workerEntry - 隔离路径 RPC 通道的宿主侧分派
