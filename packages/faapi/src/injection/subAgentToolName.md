# subAgentToolName

一句话概括：sub-agent 派发工具名的唯一生成入口——`subAgentToolName(agentName)` 拼出 `agent-<agentName>` 形式的 LLM 工具名，并保证结果满足 OpenAI 兼容协议的工具名字符集约束。

## 为什么需要

agent-as-tool 把 sub-agent 包装成 tool 发给 LLM，`function.name` 受 OpenAI 兼容协议硬约束 `^[a-zA-Z0-9_-]+$`——DeepSeek / OpenAI 等强校验上游对非法字符整单 400。历史上派发名是 `agent.<agentName>`（点号前缀 + 嵌套 agent 名的点号分隔），在强校验上游完全不可用（业务方反馈 TODO-faapi-gaps #1）。生成逻辑必须收敛到一处，保证：

- 前缀为合法字符（`agent-`），不再是 `agent.`
- 组合结果可校验——agent 名含非法字符时构建/运行期显式抛错，不把非法名字发给 LLM

## 使用场景

- `agentRegistry.asTool` / task worker 注册表视图的 `asTool` / `@faapi/agent` 的 `Agent.asTool`——包装单个 agent 为 `AgentToolDescriptor`
- `Agent.buildToolDefinitions` / `buildDeclaredTools`——组装 LLM 可见 tools 清单与执行白名单
- 业务方 authHooks——`beforeToolCall` / `filterTools` 用导出的 `SUB_AGENT_TOOL_PREFIX` 判别 sub-agent 调用，避免硬编码前缀字符串

## 设计

- `SUB_AGENT_TOOL_PREFIX = 'agent-'`——派发名前缀
- `LLM_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/`——OpenAI 兼容协议对 `function.name` 的字符集约束
- `subAgentToolName(agentName)` = `'agent-' + agentName`，组合结果不满足 pattern 时抛 `Error`（含 agent 名与改名指引）——不静默净化（掩盖配置错误），不降级放行（强校验上游 400）

agent 名本身的合法性由上游保证：文件型 agent 在 [scanAgents](../agents/scanAgents.md) 目录段校验（段内 `[a-zA-Z0-9-]`，`_` 为嵌套分隔符）+ [extractAgentMetadata](../ast/extractAgentMetadata.md) 的 `@agent` 覆盖名校验；本助手是最后一道运行时闸门（程序化 `hydrate` 的 agent 名不经构建期扫描）。

## 相关模块

- [agentRegistry](./agentRegistry.md) —— `asTool` 消费方
- [scanAgents](../agents/scanAgents.md) —— agent 名生成与目录段字符集校验（`_` 嵌套分隔符约定）
- `@faapi/agent` [agent](../../../agent/src/agent.md) —— `Agent` 类路由与 `asTool` 消费方
