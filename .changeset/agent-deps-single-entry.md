---
'@faapi/faapi': major
'@faapi/agent': major
---

createAgentDeps 收敛单一配置入口（破坏性变更）：

- `CreateAgentDepsOptions` 删除历史的 `llms` / `config` 分离参数——`agentConfig` 复合块（与 faapi.config 的 `agent` 块同构）成为唯一配置入口，三层职责收敛为：配置数值归 `agentConfig`、进程级配方归 `decorateDeps`、编程级差异归 `overrides`。存量调用方迁移：`createAgentDeps({ llms: X, config: Y })` 改写为 `createAgentDeps({ agentConfig: { ...Y, llms: X } })`，编译期即暴露（TS 报未知属性）
- `AgentConfig`（faapi.config 的 agent 块）新增 `toolTimeoutMs?: number`——单次 tool 执行超时毫秒数，未设置不限时，超时抛 `AgentToolTimeoutError` 回传 LLM；经 `toAgentRuntimeConfig` 拆装清单到达，插件与自组装两路生效
- `historyCompactor` 策略不进 faapi.config 声明面（签名引用 @faapi/agent 类型，主包不反向依赖）——官方通道改为 `agent.decorateDeps` 配方（`(deps) => ({ ...deps, config: { ...deps.config, historyCompactor } })`）或编程式 `overrides.config` 整体替换

细则见 `packages/agent/src/agentDeps.md` 与 `packages/faapi/src/configs/configTypes.md`。
