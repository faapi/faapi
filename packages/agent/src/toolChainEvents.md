# authHooks → agent tool 链事件

一句话概括：agent / tools 调用链的鉴权与横切支持——请求上下文（ctx）全链路传递 + `agent:before-tool-call` / `agent:after-tool-call` / `agent:filter-tools` 三个 app 事件（7.x 起，原 `beforeToolCall` / `afterToolCall` / `filterTools` 三钩子已移除、由事件承载），覆盖"agent → tool"与"agent → sub-agent"全部调用。

> 历史注记：三钩子原在 `faapi.config.ts` 的 `agent` 块声明（`AgentConfig`），7.x 起统一迁移为 [appEventBus](../../faapi/src/events/appEventBus.md) 事件——业务方经 `getApp().on(...)` 订阅（启动期写 `src/bootstrap.ts` 约定文件——框架在 listen 前加载执行），不再需要配置声明面。

## 为什么需要

HTTP 路由有成熟的中间件鉴权（洋葱模型），但 agent 链是另一条调用路径：handler 注入 `agent` 后，LLM 在循环里自主决定调哪些 tools、递归哪些 sub-agent——这条链此前没有任何可插拔的拦截点，且 tool handler 只收到 `args`、拿不到请求上下文，连"自查身份"都做不到。多租户/工作区场景下，任何能触达 agent 的请求，LLM 都可以无差别调用它可见的全部 tools。

## 设计：三层模型（与 handler 鉴权的关系）

| 层 | 拦截点 | 与 handler 的关系 |
|----|--------|------------------|
| 1. 入口鉴权 | HTTP 中间件（现有） | **完全一样**，零新增——调 agent 的 handler 本就在中间件链里 |
| 2. 可见性过滤 | `agent:filter-tools` 事件 | handler 没有的维度：无权 tool 不进 LLM 的 tools 清单，省一轮调用 |
| 3. 执行守卫 | `agent:before-tool-call` 事件 | handler 没有的维度：拒绝语义是 `error` 回传 LLM 调整策略，而非 403 短路 |

**不引入洋葱中间件**——tool 链的调用者是 LLM、结果是数据回传（非 HTTP 响应）、且一请求内 N 轮 × M 个 tool_call，中间件栈穿透的组合复杂度与语义都不匹配。三个事件覆盖中间件的全部实际用途（鉴权/日志/限流/参数改写）。

## ctx 传递链

```
HTTP 中间件塞 ctx.user / ctx.workspace     ← 现有模式，零新增
  └─ handler 注入 agent（AgentHandle）
      └─ toAgentToolContext 收窄 → AgentDeps.ctx   ← @faapi/agent plugin
          ├─ tool handler: (args, ctx)      ← 第二参数（AgentToolContext 契约）
          └─ sub-agent: 同一 ctx 递归传导    ← subDeps 共享 deps，ctx 随行

进程内任务（taskCtx.agent 静默通道）
  └─ createTaskToolContext 合成 → AgentDeps.ctx   ← carry 数据字段落顶层 + scoped
      tasks / 任务级 logger / job.signal（与 HTTP 同契约，见 taskToolContext.md）

隔离任务（worker 内 taskCtx.agent）
  └─ 单次 agent-run RPC 收敛宿主 → 完整循环（含事件发射）在宿主执行
      └─ 宿主 runAgent 以任务合成契约 ctx 构造 Agent（同配方合成 AgentDeps.ctx，
          见 taskToolContext.md），业务函数面与资源零跨线程

无 app 编排（测试 / 编程式）
  └─ createStandaloneToolContext 显式构造   ← 诚实缺省（tasks 抛错桩等）
```

- `AgentDeps.ctx` 类型为 `AgentToolContext`（**必填**）——契约字段（`tasks` / `log` / `signal`）由框架在三条约执行路径上合成保证正确；本契约不支持 `declare module` 增强（type alias 拒绝合并），业务身份字段以**业务类型交叉标注**携带（`type CtxWithUser = AgentToolContext & { currentUserId?: number }`）后强类型读取，cron/系统触发无身份时业务侧 fail-closed 断言拒绝。完整填充规则见主包 [agentToolContext.md](../../faapi/src/runtime/agentToolContext.md)
- sub-agent 递归不换 HTTP 请求，ctx 不变——工作区约束一路生效

## 三事件语义

### `agent:before-tool-call`（执行守卫）

`executeTool` 在 **ctx 声明即校验之后**发射（sub-agent 派发分流**之前**）——校验先于事件：ctx 装配错误是编程/装配问题（前置条件不满足），不流进业务订阅端，handler 只面对合成正确的 ctx 做业务鉴权。一个事件同时覆盖常规 tool 与 sub-agent 递归（派发工具名见 [subAgentToolName](../../faapi/src/injection/subAgentToolName.md)）；载荷不含 tool 名——按 tool/派发名路由订阅专属名 `agent:before-tool-call:<name>`（常规 tool 为 tool 名、sub-agent 为派发名 `agent-<name>`，名字在事件名里）。

载荷 `{ args, ctx, error? }`。handler 同步/异步均可（事件扇出 `await`）：

| handler 行为 | 语义 |
|------|------|
| 不动载荷 | 放行 |
| `payload.error = '...'` | 拒绝——不执行 handler，`{ error }` 回传 LLM（复用 schema 校验失败的既有模式，LLM 可据此调整策略） |
| `payload.args = {...}` | 改写后放行——多租户刚需：不信 LLM 传的 `workspaceId`（prompt 注入可诱导越权），服务端强制注入可信值 |

扇出完成后统一判定：`error` 非空 → 拒绝；否则以（可能被改写的）`payload.args` 继续。错误口径为**传播**——handler 抛错被 per-tool catch 回传主控 LLM（与原钩子同路径）。

### `agent:after-tool-call`（审计）

tool / sub-agent **成功返回后**发射（异常路径不发射）——审计/日志/计量。载荷 `{ args, result, ctx }`（不含 tool 名——按 tool/派发名路由订阅专属名 `agent:after-tool-call:<name>`），观察面：改写 `result` 不回写执行链路。错误口径为**留痕**（handler 抛错 `console.error`，不改变成功结果——与原钩子留痕约定一致）。

### `agent:filter-tools`（可见性过滤）

`buildToolDefinitions` 组装完 LLM 可见 tools 清单后发射（每次 `run` / `stream` 生效）。载荷 `{ tools, ctx }`（不含 agent 名——按 agent 路由订阅专属名 `agent:filter-tools:<agentName>`）——handler 原地 `filter`/`splice` tools 数组（含 agent-as-tool 的 `agent-x` 派发项）。tools 为 OpenAI chat completions 规范形（`type: 'function'` + `function: { name, description?, parameters? }`），按 `tool.function.name` 过滤——可见性过滤所需的 tool 名从数组项自取，不依赖载荷字段。

**只影响可见性，不拦执行**：被过滤的 tool 在注册表中仍存在，LLM 幻觉调用时 `executeTool` 照常查到并执行——**看不到 ≠ 调不到**。硬闸必须配 `agent:before-tool-call`；`agent:filter-tools` 的价值是省一轮调用与缩小 LLM 决策面，安全语义由第 3 层保证。错误口径为**传播**。

## 订阅位置

```ts
// src/bootstrap.ts（框架约定启动文件，机制见 [../faapi/src/cli/bootstrap.md](../../faapi/src/cli/bootstrap.md)）或运行期任意拿得到 app 的位置
import { getApp } from '@faapi/faapi';

const app = getApp();
// 通用订阅：实体无关的横切守卫（ctx 硬闸 + 参数强制注入——不依赖 tool 名,载荷不含 name）
app.on('agent:before-tool-call', (e) => {
  if (!e.ctx.workspace) e.error = 'workspace context required';
  if ('workspaceId' in e.args) e.args.workspaceId = (e.ctx as CtxWithUser).workspace?.id;
});
// 按 tool/派发名路由订阅专属名（名字在事件名里）——差异化策略逐 tool 声明;
// sub-agent 派发名同形态：agent:before-tool-call:agent-<name>
app.on('agent:before-tool-call:admin_deleteUser', (e) => {
  if (!isAdmin(e.ctx)) e.error = 'tool not allowed in this workspace';
});
app.on('agent:filter-tools', (e) => {
  // 可见性过滤按 tools 数组项的 function.name 过滤（不依赖载荷字段）
  e.tools = e.tools.filter((t) => t.function.name.startsWith('agent-') || isAllowed(e.ctx, t.function.name));
});
```

典型工作区场景见 [faapi-dev 技能](/.zcode/skills/faapi-dev/SKILL.md) 的「agent / tools 鉴权（工作区）」章节。

## 相关模块

- `agent.ts` - `executeTool` 发射点（before/after）+ `buildToolDefinitions` 发射点（filter-tools）
- [appEventBus](../../faapi/src/events/appEventBus.md) - 总线契约、错误口径、目录
- `plugin.ts` - `emitAppEvent` 注入（`overrides`）
- `agentHandle.ts`（faapi 包） - `getAgentHandle(ctx)` 注入点
