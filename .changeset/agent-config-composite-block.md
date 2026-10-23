---
'@faapi/faapi': minor
'@faapi/agent': minor
---

agent 配置复合块直收与生命周期配置可达性收口：

- `createAgentDeps` 新增 `agentConfig` 参数——直收 `faapi.config.ts` 的 `agent` 块复合形状（llms + 运行时旋钮），可整体透传 `ctx.config.agent` / `taskCtx.config.agent` 读回值；复合块拆装清单（含 `enableTracing` 全量字段）在工厂内单一维护，与显式 `llms` / `config` 的合并语义为「显式参数优先、agentConfig 提供底座」，存量双参数用法逐字节不变
- 插件 setup 的手写 runtimeConfig 字段清单收敛为 `agentConfig` 整体透传——修复 `config.agent.enableTracing` 在插件路径静默失效的漏拼（配置后不生效、无报错，现在全量字段两路自动到达）
- `LifecycleContext`（onBoot/onReady/onClose 钩子参数）新增 `config` 字段——faapi.config 全量活引用，与请求 `ctx.config` / 进程内任务 `taskCtx.config` 同一对象；生命周期内组装 agent（如重启续跑）经 `config.agent` 读回后透传 `createAgentDeps`，业务不再需要另立配置常量源维持两路一致

细则见 `packages/agent/src/agentDeps.md` 与 `packages/faapi/src/configs/configTypes.md`。
