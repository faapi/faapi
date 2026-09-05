---
'@faapi/agent': minor
'@faapi/faapi': minor
---

agent / tools 调用链新增鉴权钩子与请求上下文传递（authHooks）：

- **ctx 全链路传递**：`@faapi/agent` 工厂捕获请求上下文（此前工厂签名接收 ctx 但未使用），tool handler 签名扩为 `(args, ctx)`、sub-agent 自定义 `run(args, ctx)`——中间件塞入的身份信息（`ctx.user` / `ctx.workspace` 等）首次可流达 tool 层；sub-agent 递归经 deps 展开自动传导
- **`beforeToolCall` 执行守卫**（`config.agent`）：所有 tool + sub-agent 调用的必经单点（拦截在 `agent.` 分流之前，一个钩子覆盖两者）。三种返回：`void` 放行 / `{ error }` 拒绝（不执行，error 回传 LLM 调整策略）/ `{ args }` 改写后放行——多租户场景强制注入可信 `workspaceId`，不信任 LLM 传入的标识参数
- **`afterToolCall` 审计钩子**：tool / sub-agent 成功返回后调用（异常路径不调用），用于日志/审计/计量
- **`filterTools` 可见性过滤**：每次 `run` / `stream` 组装 LLM 可见 tools 清单后过滤（含 agent-as-tool 项）——无权 tool 不进 LLM 视野，比执行时拒绝省一轮调用
- **不引入洋葱中间件**：拒绝语义是 `{ error }` 回传 LLM 而非 403 短路，钩子对覆盖中间件全部实际用途；入口鉴权沿用现有 HTTP 中间件，零新增
- 设计文档见 `@faapi/agent` 的 `authHooks.md`；使用场景见 faapi-dev 技能 agent.md 的「agent / tools 鉴权（工作区）」章节
