---
'@faapi/agent': minor
'@faapi/faapi': minor
---

**AgentToolContext 契约：tool handler 第二参数必有且三路径正确**；隔离任务 `taskCtx.agent` 落地（工具宿主执行）；`FaapiContext.tasks` 字段恒在。维护者决策：保持 7.x 大版本（破坏性变更随 minor 交付，迁移点见下）。

## 破坏性变更（随 minor 交付——维护者确认保持大版本 7）

- **`AgentDeps.ctx` / `createAgentDeps` 的 `ctx` 参数改为必填**，类型从 `Partial<FaapiContext> | undefined` 收紧为 `AgentToolContext`（必有契约：`tasks` / `log` / `signal` 三字段框架三路径合成保证正确；类型声明在 `@faapi/faapi`，`@faapi/agent` re-export）。无 app 编排场景（测试直调 / 编程式脚本）用新增的 `createStandaloneToolContext` 构造（诚实缺省：tasks 抛错桩 / console logger / 永不触发 signal）。运行时同步收紧：`createAgentDeps` 对绕过类型检查的 JS 调用显式抛 `AgentError`。
- **鉴权钩子 ctx 签名收紧**：`beforeToolCall` / `afterToolCall` / `filterTools` / `resolveSubAgentInput` / `resolveSubAgentContext` 的 ctx 参数从 `Partial<FaapiContext> | undefined` 改为 `AgentToolContext`（去 undefined——运行时恒有值）。以旧签名书写的钩子经参数逆变天然兼容，无需强制迁移；显式读取 `ctx.config` 等非契约字段的钩子是迁移点。
- **`AgentHandleFactory` 签名改为 `(ctx: AgentToolContext) => unknown`**（HTTP 路径经 `toAgentToolContext` 收窄，全量请求字段随透传保留）。
- 隔离任务的工具结果 / 钩子返回值须可结构化克隆（跨 worker RPC 边界，不可克隆按执行错误显式失败）。
- **`FaapiContext.tasks` 改为必有字段**：无 app 编排（编程式裸构 / 轻量测试设施）时由 `createContext` 填充抛错桩（调用即显式失败并给修复指引），不再静默 `undefined`；`tasks` 参数注入同步改为直读 `ctx.tasks`（单一来源）——业务侧 `if (!ctx.tasks)` 形式的判空守卫需要跟进（守卫将恒过，队列交互在调用点显式报错）。

## 新能力

- **`AgentToolContext`**（`@faapi/faapi` 声明、`@faapi/agent` re-export）：tool handler 第二参数的框架契约。三路径填充规则：HTTP = `toAgentToolContext` 收窄完整请求 ctx；进程内任务 = `createTaskToolContext`（carry 数据字段落顶层 + scoped TaskClient / 任务级 logger / `job.signal`）；隔离任务 = 宿主同配方合成。业务身份字段经 `declare module '@faapi/faapi'` 增强 `AgentToolContext` 后强类型读取。详见 `packages/faapi/src/runtime/agentToolContext.md`。
- **隔离任务 `taskCtx.agent` 落地**：`agentToolRunner`（`@faapi/agent` 插件注册到 AppRegistries 的工具执行器）——worker 内 agent 编排循环把工具调用 / 钩子 / 派发钩子经 RPC 回传宿主执行（与 `Agent.executeTool` 常规分支共用 `executeToolCall`，db 等资源单实例、业务函数零跨线程）；编排循环（LLM 调用）留在 worker。插件未加载时 `taskCtx.agent` 恒 undefined（能力不存在非降级）。详见 `packages/faapi/src/tasks/taskToolContext.md`。
- **`FaapiContext.signal`**（additive）：`request.signal` 的同引用别名（客户端断开取消），同时是契约的 signal 字段来源。
- **`beforeToolCall` / `filterTools` 允许返回 Promise**（additive）——隔离路径钩子经 RPC 转发宿主执行，同步钩子不受影响。
- **`createStandaloneToolContext`**（`@faapi/agent` 导出）：无 app 编排场景的合规 ctx 构造助手（overrides 注入业务增强字段）。
- **`createTaskToolContext` / `createThrowingTaskClient` / `toAgentToolContext`**（`@faapi/faapi` 导出）：任务路径契约 ctx 合成（进程内与隔离宿主侧单一配方）、契约 tasks 字段的诚实缺省桩（`then` 返回 undefined——透传 await 链路不误触）、HTTP 路径 ctx 收窄。
