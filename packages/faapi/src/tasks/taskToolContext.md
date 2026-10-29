# taskToolContext

一句话概括：`createTaskToolContext` 把任务执行的 carry 快照与任务级能力（scoped TaskClient / 任务级 logger / job.signal）合成为契约形态的 `AgentToolContext`——任务 `taskCtx.agent` 惰性通道的执行 ctx 合成配方。

## 为什么需要

任务路径没有 HTTP 请求，tool ctx 的来源是 enqueue 时声明的 carry（身份/标记纯数据）+ 任务执行现场的任务级能力。配方单一维护，保证 `taskCtx.agent` 惰性通道构造的 Agent 之下，契约字段不被 carry 覆盖、字段不遗漏——配方漂移即静默契约破坏。

## 使用场景

- `taskQueue.ts`：`taskCtx.agent` 首次访问时经 agentHandle 工厂构造 Agent

## 合成规则

```
{ ...carry, tasks, log, signal }
```

- **carry 数据字段落顶层**——身份在 enqueue 处声明一次（`carry: { currentUserId }`），工具按增强字段直读，与 HTTP 路径中间件塞 ctx 的形态一致
- **契约字段后置展开**——carry 不可覆盖 tasks/log/signal（框架保证不被业务数据污染）
- carry 为纯数据（enqueue 时已校验可结构化克隆）

## 相关模块

- `../runtime/agentToolContext.ts` - 契约类型定义与三路径填充规则
- `./taskTypes.ts` - `TaskContext.carry`（enqueue 携带的执行上下文快照）
- `./taskQueue.md` - 消费方（`taskCtx.agent` 惰性通道）
