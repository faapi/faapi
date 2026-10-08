---
'@faapi/agent': minor
'@faapi/faapi': minor
---

feat: 轻量 LLM 补全通道——agent 循环之外的一次性补全官方出口

@faapi/agent 新增 `createLightComplete`（并由插件自动注册）：字符串进字符串出，复用 `agent.llms` 同源配置与 provider 重试引擎（指数退避 / Retry-After / 429·5xx 判定），默认 60s 超时，失败钩子 `onFailure` 与降级值 `fallback` 内建（可降级不可静默——fallback 命中且未声明钩子时框架兜底 warn）。model key 解析与 `agent.run` 同规则（llms key / provider/model / 纯 model 名）。

接入点：handler 新增 `llm` 注入参数（类型 `LlmComplete` 从 `@faapi/agent` 导入，插件未加载时 `undefined`）；任务侧 `taskCtx.llm` 双路径注入——进程内经 `registries.llm` store 惰性读取，隔离执行传 `agent.llms` 纯数据快照、worker 内动态加载 `@faapi/agent` 重建。

@faapi/faapi 新增：`llm` 内置注入名、`AppRegistries.llm`（`LlmChannelStore`）、`LlmComplete`/`LlmCompleteOptions` 规范类型（主包持有，`TaskContext.llm` 引用）、`TaskQueueDeps.llm/llms`。

provider 层（@faapi/agent）：新增 `LLMTimeoutError`（`LLMProviderError` 子类，可编程区分超时与网络错误）；`LLMCompleteRequest` 新增调用级 `timeoutMs`/`maxRetries` 覆盖；`LLMResponse.attempts` 携带实际 HTTP 尝试次数（重试耗尽抛出的错误对象同样回填）。均为可选新增字段/子类，向后兼容。
