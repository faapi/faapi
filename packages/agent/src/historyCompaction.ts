/**
 * 历史压缩策略位——类型定义 + 输出不变量守卫
 *
 * `maxHistoryTokens` 超预算时业务可注入整体替换的压缩策略（摘要式压缩等）；
 * 缺省不注入时逐字节保持现行「按轮组从最旧截断」行为（见 reactLoop.ts 的
 * trimHistory 与 reactLoop.md 历史裁剪章节）。框架不发明摘要策略——策略自由度
 * 以输出不变量为界，违反即抛 `AgentError` 不静默。
 *
 * 详见 [historyCompaction.md](./historyCompaction.md)。
 */

import type { LLMMessage } from './provider';
import { AgentError } from './agentErrors';

/** historyCompactor 入参 */
export interface HistoryCompactorInput {
  /** 超 budget 的完整发送候选（已含 system + 初始 user） */
  messages: LLMMessage[];
  /** 框架估算值（字符数 / 2，与 trimHistory 同款估算，不引入 tokenizer 依赖） */
  estimatedTokens: number;
  /** maxHistoryTokens 预算 */
  budget: number;
}

/**
 * 历史超预算时的压缩策略
 *
 * - 仅在发送副本上调用（`result.messages` 与续跑源不受影响）；仅超预算且有轮组时调用
 * - 子代理递归共享根 deps——策略位全树生效（`AgentRuntimeConfig.historyCompactor` 透传）
 * - 违反输出不变量（头部保留 / tool 配对 / 至少一轮组）抛 `AgentError`
 */
export type HistoryCompactor = (
  input: HistoryCompactorInput,
) => Promise<LLMMessage[]> | LLMMessage[];

/** 头部保留段：第一个 assistant 之前的连续前缀（system + 初始 user，永不裁剪） */
function headOf(messages: LLMMessage[]): LLMMessage[] {
  let end = 0;
  while (end < messages.length && messages[end]!.role !== 'assistant') {
    end++;
  }
  return messages.slice(0, end);
}

/**
 * 校验策略输出的三条不变量，违反抛 `AgentError`（含具体违反项与修复指引）
 *
 * 1. 头部段（system + 初始 user）必须按原顺序出现在输出最前——逐条 role + content
 *    一致（保留语义按内容判定，克隆放行）——用户目标不丢
 * 2. `tool_calls` 与 tool 结果按 `tool_call_id` 配对完整（不裁半轮）；孤立 tool
 *    消息（前一条 assistant 未调用对应 tool）同判违反
 * 3. 至少保留最近一个轮组（至少一条 assistant 消息，不发送空历史）
 *
 * 校验通过原样返回输出（便于调用点内联使用）。
 */
export function assertCompactedHistory(
  original: LLMMessage[],
  compacted: LLMMessage[],
): LLMMessage[] {
  const head = headOf(original);
  if (compacted.length < head.length) {
    throw new AgentError(
      `historyCompactor output must preserve the head segment (system + initial user, ${head.length} messages) — got ${compacted.length} messages`,
    );
  }
  for (let i = 0; i < head.length; i++) {
    const want = head[i]!;
    const got = compacted[i]!;
    if (got.role !== want.role || got.content !== want.content) {
      throw new AgentError(
        `historyCompactor output must preserve the head segment in order (message ${i + 1}: expected ${want.role}/${JSON.stringify(String(want.content)).slice(0, 80)}, got ${got.role}/${JSON.stringify(String(got.content)).slice(0, 80)}) — system and initial user must survive compaction`,
      );
    }
  }

  let sawAssistant = false;
  let pendingToolCallIds = new Set<string>();
  for (const [index, message] of compacted.entries()) {
    if (message.role === 'assistant') {
      if (pendingToolCallIds.size > 0) {
        throw new AgentError(
          `historyCompactor output breaks tool pairing (message ${index + 1}): assistant appears before tool results for tool_call_ids [${[...pendingToolCallIds].join(', ')}] — tool_calls and their tool results must stay paired (never split a turn)`,
        );
      }
      sawAssistant = true;
      pendingToolCallIds = new Set((message.tool_calls ?? []).map((c) => c.id));
    } else if (message.role === 'tool') {
      const id = message.tool_call_id;
      if (!id || !pendingToolCallIds.has(id)) {
        throw new AgentError(
          `historyCompactor output breaks tool pairing (message ${index + 1}): orphan tool result (tool_call_id: ${id ?? 'missing'}) — no preceding assistant requested it`,
        );
      }
      pendingToolCallIds.delete(id);
    }
  }
  if (pendingToolCallIds.size > 0) {
    throw new AgentError(
      `historyCompactor output breaks tool pairing: tool_calls [${[...pendingToolCallIds].join(', ')}] have no trailing tool results — tool_calls and their tool results must stay paired (never split a turn)`,
    );
  }

  if (!sawAssistant) {
    throw new AgentError(
      'historyCompactor output must keep at least one turn group (at least one assistant message) — never send an empty history',
    );
  }

  return compacted;
}
