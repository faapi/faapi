# standaloneToolContext

一句话概括：`createStandaloneToolContext(overrides?)` 为无 app 编排场景（测试直调、编程式脚本）构造合规的 `AgentToolContext`——契约字段给诚实缺省，业务字段经 overrides 显式注入。

## 为什么需要

`AgentDeps.ctx` 收紧为必填后，每一条 AgentDeps 装配路径都要提供契约 ctx：HTTP/任务路径由框架合成，但测试直调 tool handler、编程式 `new Agent(deps)`、插件 setup 的 baseDeps 占位没有 app 编排可依赖——手工拼 `{ tasks: ???, log: ???, signal: ??? }` 既啰嗦又容易造出假字段。本助手是这些场景的官方构造入口：缺省值诚实（tasks 桩调用即抛错并给修复指引，绝不静默假成功），业务身份字段显式声明。

## 使用场景

- 测试直调 tool handler：`handler(input, createStandaloneToolContext({ currentUserId: 7 }))`
- 测试组装 deps：`createAgentDeps({ registries: harness.registries, ctx: createStandaloneToolContext({ currentUserId: 7 }) })`
- 编程式脚本（无 HTTP 请求、无队列）组装 Agent
- `@faapi/agent` 插件 setup 的 baseDeps 占位（每次请求工厂以请求 ctx 覆盖）

## 缺省值

| 字段 | 缺省 | 语义 |
|------|------|------|
| `tasks` | 抛错桩（主包 `createThrowingTaskClient` 同源实现）——任意方法调用即抛错并给修复指引 | 测试/脚本环境没有任务队列，假队列会静默吞掉任务交互；显式失败让"漏注假体"第一时间暴露 |
| `log` | `createLogger('standalone')`（console 出口，框架缺省行为） | 无 app 管道可写，console 是框架缺省出口；测试可覆盖为静默实现 |
| `signal` | 新建 `AbortController` 的 signal（永不触发） | 无宿主生命周期可挂钩；需要取消语义时显式传入 |

overrides 浅合并到缺省之上，业务增强字段（currentUserId 等）与其他任意键直接落 ctx 顶层。

## 相关模块

- `../faapi/src/runtime/agentToolContext.ts` - 契约类型定义（主包持有，本包 type import）
- `./agentDeps.ts` - `createAgentDeps` 的 ctx 必填来源；插件 setup baseDeps 占位消费本助手
- `./scriptLlm.ts` - agent 流程测试的假 LLM，与本助手配套构成无 app 测试基建
