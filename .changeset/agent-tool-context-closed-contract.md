---
"@faapi/faapi": patch
"@faapi/schema": patch
"@faapi/next": patch
"@faapi/mcp": patch
"@faapi/agent": patch
---

agentToolContext 契约边界收紧：关闭 `declare module` 增强，裸标注 ctx 合法不校验

- `AgentToolContext` 由 interface 改为 type alias：业务侧 `declare module` 增强声明编译报 TS2300（同名重复标识符）。业务字段唯一通道是**交叉标注业务校验类型**（`ctx: OrderCtx & AgentToolContext`，路径依赖字段用可选字段 `?:` 表达）；`FaapiContext` / `WsContext` 的业务扩展面增强不受影响。已用增强的项目迁移：把增强字段挪进业务校验类型，读取点改交叉标注
- tool handler 第二参裸标注 `ctx: AgentToolContext` 合法：不生成 ctx schema、不校验（框架字段运行时恒注入），修复原按类型名误生成 `AgentToolContextSchema` / 构建期报错的行为
