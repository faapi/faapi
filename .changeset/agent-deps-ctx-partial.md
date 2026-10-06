---
"@faapi/agent": minor
"@faapi/faapi": minor
---

AgentDeps.ctx 类型放宽为 Partial<FaapiContext>——任务侧窄 ctx 免 cast 直传

`@faapi/agent` 的 `AgentDeps.ctx` 与 `@faapi/faapi` 的 `AgentConfig` 三个鉴权钩子（`beforeToolCall` / `afterToolCall` / `filterTools`）的 ctx 参数类型从完整 `FaapiContext` 放宽为 `Partial<FaapiContext>`。此前类型要求完整上下文，但运行时框架对 ctx 零读取、纯透传给钩子与 tool handler 第二参数——任务内组装 Agent（无 HTTP 请求）的场景按类型无法构造窄身份对象（如 tool 鉴权硬闸需要的 `{ currentUserId }`），被迫 `as unknown as FaapiContext` 断言。放宽后窄对象免 cast 直传，`declare module` 增强字段随 Partial 保留类型提示；编程式直调不传时钩子照常收到 undefined，HTTP 请求路径传完整 ctx 不受影响。

迁移说明：钩子实现若给 ctx 参数显式标注 `FaapiContext`，需删除标注（走推断）或改为 `Partial<FaapiContext>`——函数参数逆变下显式全量标注不再兼容钩子类型；未显式标注的实现无需任何改动。
