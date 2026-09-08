---
'@faapi/faapi': major
'@faapi/agent': major
---

移除 `config.agent.defaultAgent` 与 `config.agent.defaultLlm`——agent 调用全面显式化，无全局默认 agent / 默认 provider：

- `agent.run` / `agent.stream` 每次调用必须显式传 `options.agent` 指定 agent 名，不传抛 `AgentError`
- LLM 定位无默认 provider：每次调用传 `options.model`（llms key / `provider/model` / 纯 model 名）或 `options.provider`（外部 provider）；未传 `options.model` 时 agent 元数据声明的 `config.model` 作为缺省 key 参与 llms 解析，两者皆无且未传外部 provider 时抛 `AgentError`
- sub-agent 递归继承父调用解析出的 provider，model 用 sub 元数据声明的 `config.model`、未声明时沿用父 model
- `asTool` 改为显式传 agent 名：`asTool(name)`
- 原依赖 `defaultAgent` / `defaultLlm` 的配置需迁移：handler 内改为 `agent.run(input, { agent: 'name', model: 'xxx' })`
