# callTool

一句话概括：测试辅助函数——经真实分发管线（`executeToolCall`）调用 tool，与生产 agent 派发同一条校验链（input schema + ctx 声明即校验），直调 `mod.handler(input, ctx)` 的场景由本函数替代。

## 为什么需要

tool ctx 声明即校验的运行时门禁在 `executeToolCall`（agent 框架路由的唯一执行路径）。历史测试姿势 `harness.loadToolModule(...)` + `mod.handler(input, ctx)` 完全绕过校验：`ToolModule.handler` 类型为 `(...args: unknown[]) => unknown`（编译期流型检查失效），运行时零校验——业务字段（如 `currentUserId`）缺失时 handler 拿到 `undefined` 静默执行，租户隔离在测试层穿底（测试绿但生产路径会拒绝）。

与 HTTP 路由的测试方式对齐：路由不直调 handler 函数，走 `createTestServer` 真实管线；tool 的对位就是 `callTool`——走 `executeToolCall` 真实分发管线。ctx 装配错误（缺字段/错型）在测试现场**响亮抛错**，而不是静默放行。

## 使用场景

- 测试单个 tool 的行为：入参 → 结果（ctx 声明即校验在生产口径下生效）
- 测试 tool 的 input 校验契约：坏入参返回 `{ error }`（与 LLM 重试语义一致，可断言）
- harness（`createAgentTestHarness`）是唯一入口——`loadToolModule` 直调面已从 harness 移除

```ts
import { createAgentTestHarness } from '@faapi/faapi/testing';
import { callTool, createStandaloneToolContext } from '@faapi/agent';

const h = await createAgentTestHarness({ rootDir, schemaMode: 'generated' });
const ctx = createStandaloneToolContext({ currentUserId: 1 });
const result = await callTool(h, 'order_getOrder', { orderId: 'o1' }, ctx);
```

## 行为定义（详见 callTool.test.ts）

- **ctx 装配预校验**：tool 声明 `ctxTypeName` 时先对 ctx safeParse（与 `executeToolCall` 同一实现），失败**抛错**（测试自身的 ctx 构造问题属编程错误，不得以 `{ error }` 静默返回让测试假绿）
- **经 executeToolCall 分发**：input 校验失败返回 `{ error }`（原样返回，测试可断言校验契约）；handler 结果原样返回
- **free-form 模式显式抛错**：`harness.resolveToolSchema` 缺席（free-form 不生成 zod.js）时无校验可依——调用即抛错并指引改用 `schemaMode: 'generated'`，不静默放行
- **tool 不存在抛错**：与 `executeToolCall` 同语义
- **无 ctx 声明的 tool 不校验**：第二参无标注 / 裸 `AgentToolContext` 的 tool，ctx 原样透传（与分发路径口径一致）

## 相关模块

- [agent.ts](./agent.md) 的 `executeToolCall`——真实分发管线，ctx 校验实现单一来源（本函数复用）
- faapi 的 [agentTestHarness](../../faapi/src/agentTestHarness.md)——harness 提供 registries / rootDir / schema 解析器（`rootDir` 供本函数桥接 loader 与解析相对产物路径）
- [standaloneToolContext](./standaloneToolContext.md)——测试 ctx 的合规构造（业务字段经 overrides 注入）
