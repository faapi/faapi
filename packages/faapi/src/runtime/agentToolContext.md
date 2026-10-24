# agentToolContext

一句话概括：`AgentToolContext` 是 tool handler 第二参数的框架契约——必有、基础字段（tasks/log/signal）在三条约 agent 执行路径上由框架保证正确；`toAgentToolContext` 把完整请求 ctx 收窄为该契约。

## 为什么需要

tool handler 历史上收 `Partial<FaapiContext> | undefined`：ctx 有没有、完整不完整由调用方场景决定（HTTP 传完整 ctx、任务传 carry 窄对象、编程式/测试不传）。类型说谎（handler 声明 `FaapiContext` 而任务路径运行时是 carry），工具读 `ctx.tasks` / `ctx.log` 这类字段在 HTTP 正常、任务里静默 undefined——路径差异在运行时才爆炸。

契约把「工具可以依赖什么」显式化：**框架保证的对象 + 框架能保证的字段**。业务身份字段（currentUserId 等）不在框架保证范围内（框架不认识业务字段），经 `declare module` 增强进契约、由业务 fail-closed 断言消费。

## 使用场景

- tool handler 第二参数的类型标注（`@faapi/agent` 的 executeTool 恒传入）
- HTTP 路径：`injectParams` 的 `agent` 注入与 agentHandle 工厂收到的 ctx（`toAgentToolContext` 收窄）
- 任务路径：`taskQueue` 以 carry + 任务级能力合成（进程内与隔离同配方）
- 测试/编程式：`@faapi/agent` 的 `createStandaloneToolContext` 构造合规 ctx

### 三路径填充规则（契约字段）

| 字段 | HTTP | 任务（进程内） | 任务（隔离） |
|------|------|--------------|-------------|
| `tasks` | `registries.taskHandle` 注入的 app 实例 TaskClient | 同一 app 实例的 scoped TaskClient | 工具在宿主执行，收到宿主侧 scoped TaskClient |
| `log` | 请求级（scope `http`，requestId/method/path） | 任务级（scope `task:<name>`，jobId/task/attempt） | 宿主侧任务级 logger |
| `signal` | `request.signal`（客户端断开） | `job.signal`（停机/超时 abort） | 宿主侧 `job.signal` |

无队列编排的请求 ctx（轻量测试设施 `createTestServer` / 编程式裸构）：`tasks`
为**抛错桩**（`createThrowingTaskClient`）——由 `createContext` 在源头填充（字段
恒在、调用即显式失败并给修复指引，见 [createContext.md](./createContext.md) 的
「ctx.tasks 挂载」）；`@faapi/agent` 的 `createStandaloneToolContext` 复用同一实现。

### 排除清单（不进契约，访问即编译错误）

- 请求绑定字段：`request` / `headers` / `ip` / `ua` / `cookies` / `params` / `query` / `body`——任务侧物理不存在
- 宿主函数值面：`config` / `registries`——隔离路径 config 快照不含函数；工具需要配置走模块导入，需要注册表走任务 ctx
- 响应方法（`json`/`ok`/`fail` 等）——工具不产 HTTP 响应

## 行为定义（详见 agentToolContext.test.ts）

- `toAgentToolContext`：契约字段（tasks/log/signal）全部在场，值与源 ctx 同引用；ctx 上的业务增强字段原样透传（顶层可读）
- `tasks` 缺失（无队列编排的 ctx）填充抛错桩：字段恒在、调用即显式失败（诚实缺省，不静默假成功）
- `FaapiContext.signal`：createContext 从 `request.signal` 接线，abort 传播（客户端断开 → `ctx.signal.aborted`）

## 相关模块

- `contextTypes.ts` - `FaapiContext`（HTTP 路径的源对象，`signal` 字段由本契约引入）
- `../injection/injectParams.ts` - `agent` 参数注入走 `toAgentToolContext` 收窄后进 agentHandle 工厂
- `../injection/registries.ts` - `AgentHandleFactory` 签名收本契约类型
- `../tasks/taskQueue.ts` - 任务路径以同配方合成（carry + 任务级能力）
- `@faapi/agent` 的 `agentDeps.ts` / `agent.ts` - `AgentDeps.ctx` 必填为本类型，executeTool 传给 tool handler 与钩子
- `@faapi/agent` 的 `standaloneToolContext.ts` - 无 app 场景的合规 ctx 构造助手
