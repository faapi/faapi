---
'@faapi/agent': minor
'@faapi/faapi': minor
---

fix(agent,tools): 工具名全面满足 OpenAI 兼容协议字符集——派发名 `agent-` 前缀、嵌套分隔符 `_`、命名构建期校验

发给 LLM 的工具名（`function.name`）受 OpenAI 兼容协议硬约束 `^[a-zA-Z0-9_-]+$`。此前两处违反：agent-as-tool 派发名硬编码 `agent.` 点号前缀；tool / agent 名的路径分隔与层级连接用 `.`（`weather.getWeather`、嵌套 agent 名 `easy-writing.wizard`）。DeepSeek / OpenAI 等强校验上游对整个 tools 数组直接 400（`Invalid 'tools[n].function.name': string does not match pattern`），带子代理派发或嵌套 tool 的对话整轮失败（业务方反馈 TODO-faapi-gaps #1）。

**agent 侧**：

- **派发工具名 `agent.xxx` → `agent-xxx`**：主包新增 `subAgentToolName(agentName)` 作为唯一生成入口（导出 `subAgentToolName` / `SUB_AGENT_TOOL_PREFIX` / `LLM_TOOL_NAME_PATTERN`），三处 `asTool`（`agentRegistry.asTool`、task worker 注册表视图、`Agent.asTool`）与 `Agent.buildToolDefinitions` 统一走它。
- **agent 嵌套名分隔符 `.` → `_`**：目录推导名 `/` 规范化为 `_`（旧为 `.`），嵌套 agent `src/agents/easy-writing/wizard/` 的注册名变为 `easy-writing_wizard`，派发名 `agent-easy-writing_wizard` 整体合法；trace 的 `subagent_call.agentName` 剥前缀即精确还原。
- **agent 名字符集构建期校验**：agent 目录段须匹配 `^[a-zA-Z0-9-]+$`（工具名字符集再禁 `_`——`_` 独占嵌套分隔符语义）；`@agent` JSDoc 覆盖名须整体匹配 `^[a-zA-Z0-9_-]+$`（无嵌套语义，`_` 可用）。违例扫描 / AST 阶段显式抛错。
- **执行路由改声明来源判定**：`Agent.buildLoopConfig` 构建「派发名 → agent 名」映射与常规 tool 声明集合，`executeTool` 按声明集合路由，不再 `startsWith` 猜测——真工具 `agent-foo` 与 sub-agent `foo` 的派发名互不误伤（未声明的注册真工具也不会遮蔽派发名）。
- **构建期冲突显式抛 `AgentError`**：sub-agent 派发名与该 agent 声明的常规 tool 名相同时启动 / run 即报错——静默遮蔽会让一方不可达。

**tool 侧（同规则迁移）**：

- **命名连接符 `.` → `_`**：tool 名 = 命名空间 + `_` + 函数名（旧为 `.`），嵌套命名空间段间也用 `_`（`src/tools/a/b/handler.ts` 导出 `deep` → `a_b_deep`，旧 `a.b.deep`）。
- **字符集构建期校验**：tool 目录段须匹配 `^[a-zA-Z0-9-]+$`（同 agent 目录段规则）；合成 tool 名整体须匹配 `^[a-zA-Z0-9_-]+$`（函数名含 `$` 等非法字符时抛错）。`@tool` JSDoc 覆盖名须整体匹配 `^[a-zA-Z0-9_-]+$`，违例 AST 阶段抛错。违例均显式报错（含路径与改名 / `@tool` 覆盖指引），不静默净化。

**迁移提示**（业务方需同步修改）：

1. authHooks 中按 `agent.` 前缀判别 sub-agent 的逻辑改为 `agent-`（建议 import 主包 `SUB_AGENT_TOOL_PREFIX`，不硬编码）。
2. 嵌套 agent 的引用名：`agents: ['a.b']` → `agents: ['a_b']`，`agent.run(input, { agent: 'a.b' })` → `'a_b'`。
3. agent / tool 目录名含 `.` 或 `_` 的需改名（段内只允许字母数字连字符；旧版平铺点号目录 `easy-writing.wizard/` → `easy-writing-wizard/`），否则构建报错。
4. 带命名空间的 tool 引用名：agent config `tools: ['weather.getWeather']` → `tools: ['weather_getWeather']`；authHooks 的 tool 名匹配同步改。
5. LLM 对话历史里持久化的旧工具名（`agent.xxx` / `weather.getWeather`）不映射到新名——跨版本续跑的对话中旧名调用会被声明集合拒绝并回传 LLM。
