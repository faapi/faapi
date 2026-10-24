---
'@faapi/faapi': minor
'@faapi/agent': minor
---

agent 配置新增进程级 deps 配方声明通道 `decorateDeps`：

- `faapi.config.ts` 的 `agent` 块新增 `decorateDeps` 字段——真实签名 `(deps: AgentDeps) => AgentDeps`（类型在 `@faapi/agent`，主包按接受任意函数的手法声明，业务侧导入 `AgentDeps` 标注即完全强类型），用于声明进程级 deps 差异项：schema 富化包装（`resolveToolSchema` / `resolveAgentInputSchema`）、派发材料供数（`resolveSubAgentInput`）、providers 进程级复用等
- `createAgentDeps` 在 base 装配之上、显式 `overrides` 之前应用该配方（装配次序 base → decorateDeps → overrides，显式优先）；配方抛错原样冒泡不静默降级
- 插件 setup 与业务自组装（任务内 / 生命周期内）都经同一工厂装配——配方在 faapi.config 声明一次，HTTP 请求链注入的 AgentHandle 与自组装路径两路同源到达；此前这类差异项只能在业务侧自组装代码里手拼 overrides，插件注入路径无法携带

细则见 `packages/agent/src/agentDeps.md` 与 `packages/faapi/src/configs/configTypes.md`。
