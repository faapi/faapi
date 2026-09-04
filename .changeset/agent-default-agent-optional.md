---
'@faapi/agent': minor
---

`config.agent.defaultAgent` 改为可选：未设置时插件正常注册工厂，handler 通过 `agent.run(input, { agent: 'name' })` / `agent.stream(input, { agent: 'name' })` 按调用指定 agent。两者均未指定时 `run`/`stream` 抛 `AgentError`。此前未设置 `defaultAgent` 会跳过工厂注册（`agent` 参数注入 `undefined`）。
