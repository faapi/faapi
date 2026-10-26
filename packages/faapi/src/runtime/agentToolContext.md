# agentToolContext

一句话概括：tool handler 第二参数（ctx）的类型由**业务自定义**，框架对其实施「声明即校验」——构建期 AST 提取业务校验类型生成 schema，运行时分发点对合成 ctx 做 safeParse，不满足则不调用 handler；`AgentToolContext` 是框架注入字段（tasks/log/signal）的载体，作为交叉标注侧参与 ctx 类型声明。

## 为什么需要

tool handler 历史上收 `Partial<FaapiContext> | undefined`：ctx 有没有、完整不完整由调用方场景决定（HTTP 传完整 ctx、任务传 carry 窄对象、编程式/测试不传）。类型说谎（handler 声明 `FaapiContext` 而任务路径运行时是 carry），工具读 `ctx.tasks` / `ctx.log` 这类字段在 HTTP 正常、任务里静默 undefined——路径差异在运行时才爆炸。

`AgentToolContext` 契约先解决了框架字段的问题：**框架注入字段（tasks/log/signal）恒在恒正确**，三路径填充规则见下表。业务字段（currentUserId 等）框架不认识、也无法在类型上代为承诺——业务对 ctx 字段的要求由业务自己的类型声明，框架按声明校验。

## tool ctx 声明即校验（业务字段口径）

业务在 tool handler 第二参声明 ctx 类型，三种形态：

```ts
// src/tools/order/handler.ts
import type { AgentToolContext } from '@faapi/faapi';

// 业务校验类型——纯数据字段（框架字段进不了这里：extends AgentToolContext
// 会因 import('...').TaskClient 类型语法构建期抛 SchemaExtractionError）
interface OrderCtx {
  currentUserId: number;
}

// 形态 1：只用业务字段
export function getOrder(input: { orderId: string }, ctx: OrderCtx) {
  ctx.currentUserId; // 运行时校验保证在场，消费点零断言
}

// 形态 2：交叉标注携带框架字段（类型层供给，不参与校验）
export function listOrders(input: {}, ctx: OrderCtx & AgentToolContext) {
  ctx.currentUserId;      // 校验保证
  ctx.log.info('...');    // 框架字段类型在（运行时恒注入）
}

// 形态 2 的命名别名等价写法（拆分规则同内联交叉，构建期对别名解引用）
type OrderToolCtx = OrderCtx & AgentToolContext;
export function listOrders2(input: {}, ctx: OrderToolCtx) { /* 同上 */ }

// 形态 3：裸标注只要框架字段（无业务校验类型——框架字段运行时恒注入，不生成 schema 不校验）
export function ping(input: {}, ctx: AgentToolContext) {
  ctx.log.info('...');    // 框架字段类型在（运行时恒注入）
}
```

| 阶段 | 行为 |
|------|------|
| 构建期 | AST 提取第二参业务校验类型名（交叉类型拆分跳过 `AgentToolContext` 侧；业务侧无法唯一具名——多成员/内联字面量/混合——取默认名：别名名或 `${函数名}Ctx`，内联标注同样生成 schema；裸标注框架类型及仅框架侧交叉不提取），`ctxTypeName` 进 `faapi-tools.js` 清单，同文件 `zod.js` 追加导出 `${ctxTypeName}Schema`（提取规则详见 [extractToolMetadata](../ast/extractToolMetadata.md) 的「第二个参数的 ctx 校验类型名」） |
| 运行时 | `executeToolCall` 在 input 校验后按 `ctxTypeName` 解析 schema（复用 `resolveToolSchema` 同一实例与缓存）对合成 ctx safeParse——失败返回 `{ error }` 回传 LLM，不调用 handler（对齐 input 校验语义；错误消息指明是 ctx 前置条件不满足，非 LLM 入参问题） |
| 无声明 | 第二参无标注 / 关键词类型（`unknown` 等） / 裸标注 `AgentToolContext` / 仅框架侧交叉 / 无第二参 → 无 schema 无校验，ctx 原样透传（向后兼容；内联字面量标注已支持——默认名 `${函数名}Ctx` 生成校验，见构建期行） |

「构造不完全就不能调用」的强制点：**tool 的唯一受支持调用路径是真实分发管线 `executeToolCall`**（agent 派发——HTTP / 进程内任务 / 隔离任务三路径），ctx 在运行时校验（缺字段/错型拒绝执行）。校验门禁提升到 `Agent.executeTool` 内 **agent:before-tool-call 事件之前**（仅真工具派发；schemaCache 与 executeToolCall 的二次校验共用实例缓存——二次校验为防御纵深）：ctx 装配错误是编程/装配问题，不流进业务订阅端。测试不走 handler 直调——`@faapi/agent` 的 `callTool`（harness + executeToolCall 真实管线，ctx 装配错误响亮抛错；见 [callTool](../../../agent/src/callTool.md)），对位 HTTP 层 `createTestServer`。直调 `mod.handler(input, ctx)` 不是受支持场景：`ToolModule.handler` 参数为 `unknown[]`，编译期与运行时均无防护，业务字段缺失会静默执行（租户隔离穿底）。编程式 ctx 构造的完整性由 `createStandaloneToolContext` 泛型流型在编译期辅助拦截——构造时漏传业务字段，返回类型缺字段，赋给 handler 的 ctx 参数类型编译报错（见 [standaloneToolContext](../../../agent/src/standaloneToolContext.md)）。

**不支持 `declare module` 增强**（本契约刻意声明为 type alias 而非 interface）：业务侧 `declare module '@faapi/faapi' { interface AgentToolContext { ... } }` 直接编译报错（TS2300 同名重复标识符）。增强是交叉标注之外的第二条业务字段通道——语义分裂（增强侧可选不校验、校验类型侧必填校验），且「类型在、运行时路径依赖在场」的中间态靠消费方自觉 fail-closed 兜底，与 fail-fast 哲学不符。业务字段唯一通道是**交叉标注业务校验类型**：路径依赖的可选读取面用可选字段表达（`chatNovelId?: number`），缺席通过校验、读取点自断言；必填字段由运行时校验裁决。HTTP 请求 ctx（`FaapiContext`）的业务增强不受此限——那是业务的扩展面，框架对非契约字段只透传不生产。

### 三路径填充规则（框架注入字段）

| 字段 | HTTP | 任务（进程内） | 任务（隔离） |
|------|------|--------------|-------------|
| `tasks` | `registries.taskHandle` 注入的 app 实例 TaskClient | 同一 app 实例的 scoped TaskClient | 工具在宿主执行，收到宿主侧 scoped TaskClient |
| `log` | 请求级（scope `http`，requestId/method/path） | 任务级（scope `task:<name>`，jobId/task/attempt） | 宿主侧任务级 logger |
| `signal` | `request.signal`（客户端断开） | `job.signal`（停机/超时 abort） | 宿主侧 `job.signal` |

无队列编排的请求 ctx（轻量测试设施 `createTestServer` / 编程式裸构）：`tasks`
为**抛错桩**（`createThrowingTaskClient`）——由 `createContext` 在源头填充（字段
恒在、调用即显式失败并给修复指引，见 [createContext.md](./createContext.md) 的
「ctx.tasks 挂载」）；`@faapi/agent` 的 `createStandaloneToolContext` 复用同一实现。

### 排除清单（不进 AgentToolContext，访问即编译错误）

- 请求绑定字段：`request` / `headers` / `ip` / `ua` / `cookies` / `params` / `query` / `body`——任务侧物理不存在
- 宿主函数值面：`config` / `registries`——隔离路径 config 快照不含函数；工具需要配置走模块导入，需要注册表走任务 ctx
- 响应方法（`json`/`ok`/`fail` 等）——工具不产 HTTP 响应

## 行为定义（详见 agentToolContext.test.ts）

- `toAgentToolContext`：框架字段（tasks/log/signal）全部在场，值与源 ctx 同引用；ctx 上的业务字段原样透传（顶层可读，供校验与 handler 消费）
- `tasks` 缺失（无队列编排的 ctx）填充抛错桩：字段恒在、调用即显式失败（诚实缺省，不静默假成功）
- `FaapiContext.signal`：createContext 从 `request.signal` 接线，abort 传播（客户端断开 → `ctx.signal.aborted`）

## 相关模块

- `contextTypes.ts` - `FaapiContext`（HTTP 路径的源对象，`signal` 字段由本契约引入）
- `../injection/injectParams.ts` - `agent` 参数注入走 `toAgentToolContext` 收窄后进 agentHandle 工厂
- `../injection/registries.ts` - `AgentHandleFactory` 签名收本契约类型
- `../tasks/taskQueue.ts` - 任务路径以同配方合成（carry + 任务级能力）
- `../ast/extractToolMetadata.md` - 构建期 `ctxTypeName` 提取（交叉类型拆分规则）
- `@faapi/agent` 的 `agentDeps.ts` / `agent.ts` - `AgentDeps.ctx` 必填，executeTool 执行 ctx 校验后传给 tool handler 与钩子
- `@faapi/agent` 的 `standaloneToolContext.ts` - 无 app 场景的合规 ctx 构造助手（泛型流型）
