---
'@faapi/agent': minor
---

`agent.run` / `agent.stream` 新增 `options.provider`——调用时传入外部 provider（`LlmConfig` 配置对象或 `LLMProvider` 实例），本次调用完全不查 `config.agent.llms`。适用于 BYOK（用户自带 apiKey）、按请求指定 baseURL 网关、注入自定义 `LLMProvider` 实现（内部自研模型网关）等场景。传入时 `options.model` 变为原始 model 名原样透传（不做 llms key 解析，支持带 `/` 的 model id）；仅本次调用生效，sub-agent 递归不继承。

`config.agent.llms` 变为真正可选：未配置 llms 时 `@faapi/agent` 插件仍注册 agent handle 工厂，`agent` 参数正常注入，但 `agent.run/stream` 不传 `options.provider` 时抛 `AgentError`（原先 llms 缺失直接跳过注册，`agent` 参数为 `undefined`）。`config.agent.defaultLlm` 指向不存在的 key 时从「跳过注册」放宽为「warn + 照常注册（无默认 provider）」。服务端不托管 LLM 凭证、凭证完全由请求侧提供的项目，现在可以只声明 `plugins: ['@faapi/agent']` 而不配置 `agent.llms`。
