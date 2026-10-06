---
'@faapi/agent': minor
'@faapi/faapi': minor
---

fix(agent): sub-agent 派发工具名改为 `agent-<agentName>`，agent 名字符集校验——满足 OpenAI 兼容协议工具名规范

派发工具名（agent-as-tool）此前硬编码 `agent.` 点号前缀，不满足 OpenAI 兼容协议对 `function.name` 的硬约束 `^[a-zA-Z0-9_-]+$`——DeepSeek / OpenAI 等强校验上游对整个 tools 数组直接 400（`Invalid 'tools[n].function.name': string does not match pattern`），带子代理派发的对话整轮失败。

本变更（业务方反馈 TODO-faapi-gaps #1）：

- **派发工具名 `agent.xxx` → `agent-xxx`**：主包新增 `subAgentToolName(agentName)` 作为唯一生成入口（导出 `subAgentToolName` / `SUB_AGENT_TOOL_PREFIX` / `LLM_TOOL_NAME_PATTERN`），三处 `asTool`（`agentRegistry.asTool`、task worker 注册表视图、`Agent.asTool`）与 `Agent.buildToolDefinitions` 统一走它。
- **agent 嵌套名分隔符 `.` → `_`**：目录推导名 `/` 规范化为 `_`（旧为 `.`），嵌套 agent `src/agents/easy-writing/wizard/` 的注册名由 `easy-writing.wizard` 变为 `easy-writing_wizard`，派发名 `agent-easy-writing_wizard` 整体合法；派发名反解析（trace 的 `subagent_call.agentName`）剥前缀即精确还原。
- **agent 名字符集构建期校验**：agent 目录段须匹配 `^[a-zA-Z0-9-]+$`（工具名字符集再禁 `_`——`_` 独占嵌套分隔符语义，段内 `_` 会让嵌套与段内下划线不可区分）；`@agent` JSDoc 覆盖名须整体匹配 `^[a-zA-Z0-9_-]+$`（无嵌套语义，`_` 可用）。违例扫描 / AST 阶段显式抛错。
- **执行路由改声明来源判定**：`Agent.buildLoopConfig` 构建「派发名 → agent 名」映射与常规 tool 声明集合两个结构，`executeTool` 按声明集合路由，不再 `startsWith` 猜测——真工具 `agent-foo` 与 sub-agent `foo` 的派发名互不误伤（未声明的注册真工具也不会遮蔽派发名）。
- **构建期冲突显式抛 `AgentError`**：sub-agent 派发名与该 agent 声明的常规 tool 名相同（如声明 tool `agent-writer` 又声明 sub-agent `writer`）时启动 / run 即报错——静默遮蔽会让一方不可达。

**迁移提示**（业务方需同步修改）：

1. authHooks 中按 `agent.` 前缀判别 sub-agent 的逻辑改为 `agent-`（建议 import 主包 `SUB_AGENT_TOOL_PREFIX`，不硬编码）。
2. 嵌套 agent 的引用名：`agents: ['a.b']` → `agents: ['a_b']`，`agent.run(input, { agent: 'a.b' })` → `'a_b'`。
3. agent 目录名含 `.` / `_` 的（含旧版支持的平铺点号目录 `easy-writing.wizard/`）需改为连字符（`easy-writing-wizard/`），否则构建报错。
4. LLM 对话历史里持久化的旧派发工具名（`agent.xxx`）不映射到新名——跨版本续跑的对话中旧名调用会被声明集合拒绝并回传 LLM。

已知边界：嵌套 tool 目录的 tool 名（`命名空间.函数名`，如 `weather.getWeather`）仍含点号，同样会被强校验上游拒绝——本次仅覆盖 agent 命名，tool 命名迁移需单独决策。
