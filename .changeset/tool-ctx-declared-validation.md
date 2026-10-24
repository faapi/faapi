---
'@faapi/faapi': minor
'@faapi/agent': minor
---

feat: tool ctx 声明即校验——业务自定义 ctx 类型，框架按声明校验

tool handler 第二参数（ctx）的类型由业务自定义，不再要求符合 `AgentToolContext` 契约：

- **构建期**：AST 提取第二参业务校验类型名（`ctxTypeName`，交叉类型 `OrderCtx & AgentToolContext` 拆分跳过框架侧；多个业务成员显式抛错），进 `faapi-tools.js` 清单，同文件 `zod.js` 追加导出 `${ctxTypeName}Schema`
- **运行时**：`executeToolCall` 在 input 校验后按 ctx 声明对合成 ctx safeParse——失败返回 `{ error }` 回传 LLM（错误消息指明是 ctx 装配问题非入参问题），不调用 handler。缺字段/错型的 ctx 构造在分发点被强制拦截
- **`AgentToolContext` 语义调整**：从"handler 第二参数契约"调整为"框架注入字段（tasks/log/signal）载体 + 交叉标注侧"——需要框架字段时写 `ctx: OrderCtx & AgentToolContext`；**不要 extends**（框架字段类型语法构建期提取即抛 `SchemaExtractionError`，此前 extends 声明不被校验、业务字段本就不生效）
- **`createStandaloneToolContext` 泛型流型**（重载双签名）：带业务字段调用返回 `AgentToolContext & T`（字段类型流型，消费点结构检查）；无参调用精确返回裸契约——直调链路构造漏传在编译期拦截（无参走非泛型精确返回：泛型默认值 `Record<string, never>` 的索引签名会让缺字段检查穿透，tsc 实测）
- `declare module` 往 `AgentToolContext` 写必填业务字段不可用（框架包内编译看不到增强，漏传静默穿透）；可选增强仍可用于 authHooks 等不走校验的读取面

口径详见 `packages/faapi/src/runtime/agentToolContext.md` 与 `packages/agent/src/standaloneToolContext.md`。
