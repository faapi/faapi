---
'@faapi/agent': minor
---

`agent.run` / `agent.stream` 新增 `options.provider`——调用时传入外部 provider（`LlmConfig` 配置对象或 `LLMProvider` 实例），本次调用完全不查 `config.agent.llms`。适用于 BYOK（用户自带 apiKey）、按请求指定 baseURL 网关、注入自定义 `LLMProvider` 实现（内部自研模型网关）等场景。传入时 `options.model` 变为原始 model 名原样透传（不做 llms key 解析，支持带 `/` 的 model id）；仅本次调用生效，sub-agent 递归不继承。
