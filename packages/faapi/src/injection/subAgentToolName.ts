/**
 * sub-agent 派发工具名生成（唯一入口）
 *
 * agent-as-tool 把 sub-agent 包装成 tool 发给 LLM，`function.name` 受 OpenAI 兼容协议
 * 硬约束 `^[a-zA-Z0-9_-]+$`——DeepSeek / OpenAI 等强校验上游对非法字符整单 400。
 * 历史上派发名是 `agent.<agentName>`（点号前缀 + 嵌套 agent 名的点号分隔），在强校验
 * 上游完全不可用（业务方反馈 TODO-faapi-gaps #1）。
 *
 * 命名规则：`agent-` 前缀 + agent 名直拼。agent 名的合法性由上游保证——文件型 agent
 * 在 scanAgents 目录段校验（段内 `[a-zA-Z0-9-]`，`_` 为 `/` 规范化后的嵌套分隔符）、
 * `@agent` 覆盖名在 extractAgentMetadata 校验（整体 `^[a-zA-Z0-9_-]+$`）；本模块对组合
 * 结果做最后一道运行时闸门（程序化 hydrate 的 agent 名不经构建期扫描），违例显式抛错
 * ——不静默净化（掩盖配置错误），不降级放行（强校验上游 400）。
 *
 * 详见 [subAgentToolName.md](./subAgentToolName.md)。
 */

/** OpenAI 兼容协议对 LLM 工具名（function.name）的字符集约束 */
export const LLM_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

/** sub-agent 派发工具名前缀（旧版 `agent.` 点号前缀违反上述字符集，已废弃） */
export const SUB_AGENT_TOOL_PREFIX = 'agent-';

/**
 * 生成 sub-agent 派发工具名：`agent-<agentName>`
 *
 * @param agentName agent 注册名（scanAgents 目录推导或 `@agent` 覆盖名）
 * @returns 满足 {@link LLM_TOOL_NAME_PATTERN} 的派发工具名
 * @throws agent 名含工具名字符集之外的字符时抛错（含原名与改名指引）
 */
export function subAgentToolName(agentName: string): string {
  const toolName = SUB_AGENT_TOOL_PREFIX + agentName;
  if (!LLM_TOOL_NAME_PATTERN.test(toolName)) {
    throw new Error(
      `Sub-agent tool name "${toolName}" (from agent name "${agentName}") violates the LLM tool name pattern ${LLM_TOOL_NAME_PATTERN} — ` +
        "rename the agent (allowed: a-z A-Z 0-9 '-' '_'; file-based agent directory segments allow a-z A-Z 0-9 '-' only, '_' is the nesting separator)",
    );
  }
  return toolName;
}
