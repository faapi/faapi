import { describe, it, expect } from 'vitest';
import { SUB_AGENT_TOOL_PREFIX, LLM_TOOL_NAME_PATTERN, subAgentToolName } from './subAgentToolName';

describe('subAgentToolName', () => {
  it('平铺 agent 名：agent- 前缀直拼', () => {
    expect(subAgentToolName('researcher')).toBe('agent-researcher');
    expect(subAgentToolName('story-reader')).toBe('agent-story-reader');
  });

  it('嵌套 agent 名（_ 为嵌套分隔符）：原样拼接', () => {
    expect(subAgentToolName('easy-writing_wizard')).toBe('agent-easy-writing_wizard');
    expect(subAgentToolName('a_b_c')).toBe('agent-a_b_c');
  });

  it('组合结果满足 OpenAI 兼容工具名字符集（^[a-zA-Z0-9_-]+$）', () => {
    for (const name of ['researcher', 'story-reader', 'easy-writing_wizard', 'a_b_c']) {
      const toolName = subAgentToolName(name);
      expect(LLM_TOOL_NAME_PATTERN.test(toolName)).toBe(true);
    }
  });

  it('agent 名含点（旧版嵌套分隔符）→ 抛错并含原名与改名指引', () => {
    expect(() => subAgentToolName('easy-writing.wizard')).toThrow(/easy-writing\.wizard/);
    expect(() => subAgentToolName('easy-writing.wizard')).toThrow(/a-z A-Z 0-9/);
  });

  it('agent 名含其他非法字符（中文/空格）→ 抛错', () => {
    expect(() => subAgentToolName('写作')).toThrow(/LLM tool name/);
    expect(() => subAgentToolName('a b')).toThrow(/LLM tool name/);
  });

  it('SUB_AGENT_TOOL_PREFIX 为 agent-（旧版 agent. 已废弃——点号违反工具名字符集）', () => {
    expect(SUB_AGENT_TOOL_PREFIX).toBe('agent-');
  });
});
