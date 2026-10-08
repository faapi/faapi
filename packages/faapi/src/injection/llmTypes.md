# llmTypes（轻量 LLM 补全通道规范类型）

一句话概括：`LlmComplete` / `LlmCompleteOptions` 的规范类型定义——轻量补全通道（`@faapi/agent` 的 `createLightComplete` 实现）的接口契约，主包持有。

## 为什么需要

轻量补全通道要同时出现在主包的 `TaskContext.llm` / `TaskQueueDeps.llm` / `AppRegistries.llm` 类型上，而主包不能反向依赖 `@faapi/agent`（依赖方向是 agent → 主包 peer）。因此类型规范放主包（与 `LlmConfig` 同home——agent 子系统的配置类型本就由主包持有），`@faapi/agent` 实现并 re-export，业务方统一从 `@faapi/agent` 导入标注（单一来源，无重复定义）。

`onFailure` 的 error 参数在此层是 `Error`——具体错误类（`LLMProviderError` / `LLMTimeoutError`）由实现层抛出，业务方 `instanceof` 细分时从 `@faapi/agent` 导入类做窄化，主包类型无需感知。

## 使用场景

- `@faapi/agent` 的 `createLightComplete` 实现此接口并 re-export 类型
- `TaskContext.llm` / `AppRegistries.llm`（LlmChannelStore）/ `TaskQueueDeps` 的类型引用

## 相关模块

- [registries](./registries.md)——`LlmChannelStore` 存储本接口实例（插件注册）
- [taskTypes](../task/taskTypes.md)——`TaskContext.llm` 注入
- `@faapi/agent` [lightComplete](../../../agent/src/lightComplete.md)——实现方与使用文档
