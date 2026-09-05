# authHooks

一句话概括：agent / tools 调用链的鉴权与横切支持——请求上下文（ctx）全链路传递 + `beforeToolCall` / `afterToolCall` / `filterTools` 三个钩子，覆盖"agent → tool"与"agent → sub-agent"全部调用。

## 为什么需要

HTTP 路由有成熟的中间件鉴权（洋葱模型），但 agent 链是另一条调用路径：handler 注入 `agent` 后，LLM 在循环里自主决定调哪些 tools、递归哪些 sub-agent——这条链此前没有任何可插拔的拦截点，且 tool handler 只收到 `args`、拿不到请求上下文，连"自查身份"都做不到。多租户/工作区场景下，任何能触达 agent 的请求，LLM 都可以无差别调用它可见的全部 tools。

## 设计：三层模型（与 handler 鉴权的关系）

| 层 | 拦截点 | 与 handler 的关系 |
|----|--------|------------------|
| 1. 入口鉴权 | HTTP 中间件（现有） | **完全一样**，零新增——调 agent 的 handler 本就在中间件链里 |
| 2. 可见性过滤 | `filterTools`（本模块） | handler 没有的维度：无权 tool 不进 LLM 的 tools 清单，省一轮调用 |
| 3. 执行守卫 | `beforeToolCall`（本模块） | handler 没有的维度：拒绝语义是 `{ error }` 回传 LLM 调整策略，而非 403 短路 |

**不引入洋葱中间件**——tool 链的调用者是 LLM、结果是数据回传（非 HTTP 响应）、且一请求内 N 轮 × M 个 tool_call，中间件栈穿透的组合复杂度与语义都不匹配。钩子对覆盖中间件的全部实际用途（鉴权/日志/限流/参数改写）。

## ctx 传递链

```
HTTP 中间件塞 ctx.user / ctx.workspace     ← 现有模式，零新增
  └─ handler 注入 agent（AgentHandle）
      └─ 工厂捕获 ctx → AgentDeps.ctx       ← @faapi/agent plugin（此前工厂丢弃了 ctx）
          ├─ tool handler: (args, ctx)      ← 第二参数（此前只有 args）
          └─ sub-agent: 同一 ctx 递归传导    ← subDeps 展开 deps，ctx 随行
```

- 编程式调用（测试 / 自定义启动器直接 `new Agent(deps)`）不传 ctx，钩子收到 `undefined`——诚实反映"没有请求上下文"，业务方在钩子里自行决定拒绝与否
- sub-agent 递归不换 HTTP 请求，ctx 不变——工作区约束一路生效

## 钩子语义

### `beforeToolCall(name, args, ctx)`

`executeTool` 最开头调用（`agent.` 分流**之前**）——一个钩子同时覆盖常规 tool（`name = 'weather.getWeather'`）与 sub-agent 递归（`name = 'agent.researcher'`），业务方按前缀区分策略。不需要平行的 `beforeAgentCall`。

三种返回：

| 返回 | 语义 |
|------|------|
| `void` / `undefined` | 放行 |
| `{ error: string }` | 拒绝——不执行 handler，`{ error }` 回传 LLM（复用 schema 校验失败的既有模式，LLM 可据此调整策略） |
| `{ args: Record<string, unknown> }` | 改写后放行——多租户刚需：不信 LLM 传的 `workspaceId`（prompt 注入可诱导越权），服务端强制注入可信值 |

### `afterToolCall(name, args, result, ctx)`

tool / sub-agent **成功返回后**调用（异常路径不调用）——审计/日志/计量。返回值忽略。

### `filterTools(tools, ctx)`

`buildToolDefinitions` 组装完 LLM 可见 tools 清单后调用（每次 `run` / `stream` 生效），返回过滤后的数组。含 agent-as-tool（`agent.x` 项）。

**只影响可见性，不拦执行**：被过滤的 tool 在注册表中仍存在，LLM 幻觉调用时 `executeTool` 照常查到并执行——**看不到 ≠ 调不到**。硬闸必须配 `beforeToolCall`；`filterTools` 的价值是省一轮调用与缩小 LLM 决策面，安全语义由第 3 层保证。

## 配置位置

三个钩子都在 `faapi.config.ts` 的 `agent` 下声明（`AgentConfig`，业务方写逻辑），由 `@faapi/agent` 插件读入 `AgentRuntimeConfig`。典型工作区场景见 [faapi-dev 技能](/.zcode/skills/faapi-dev/SKILL.md) 的「agent / tools 鉴权（工作区）」章节。

## 相关模块

- `agent.ts` - `AgentRuntimeConfig` 钩子字段 + `executeTool` 拦截点 + `buildToolDefinitions` 过滤点
- `plugin.ts` - 工厂捕获 ctx（`AgentHandleFactory` 签名本就接收 ctx）
- `agentHandle.ts`（faapi 包） - `getAgentHandle(ctx)` 注入点
- `../../faapi/src/config/configTypes.ts` - `AgentConfig` 用户配置面字段
