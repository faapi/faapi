/**
 * createScriptLLM——官方脚本假 LLM（agent 流程测试的确定性 provider）
 *
 * 按序回放预设回合（纯文本收尾或发起 tool_calls）、快照每轮完整请求、
 * 脚本用尽再被调用即抛错。返回对象自身满足 `LLMProvider`，作
 * `agent.run(input, { agent, provider })` 的 `options.provider` 注入；
 * 子代理递归继承同一实例——脚本跨主控与子代理按调用顺序连续编排。
 *
 * 详见 [scriptLlm.md](./scriptLlm.md)。
 */

import type {
  LLMCompleteRequest,
  LLMMessage,
  LLMProvider,
  LLMResponse,
  LLMStreamChunk,
  LLMToolCall,
} from './provider';

/**
 * 脚本回合：assistant 的一次响应
 *
 * - `content` + `toolCalls` 均省略 → 空文本回合（stopReason='stop'）
 * - `toolCalls` 非空 → stopReason='tool_calls'（reactLoop 转入工具执行）
 */
export interface ScriptTurn {
  /** assistant 回合的文本内容 */
  content?: string;
  /** 发起的工具调用（arguments 对象序列化为 JSON 字符串） */
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
}

/**
 * 脚本假 LLM（`LLMProvider` + 请求快照）
 *
 * `complete` 与 `stream` 共享同一游标——两种消费模式按调用顺序连续回放。
 */
export interface ScriptedLLM extends LLMProvider {
  /** 每轮发给 LLM 的完整请求快照（断言历史/系统提示词/工具结果回灌用） */
  requests: LLMCompleteRequest[];
}

/** 流程测试不测计费——usage 恒定占位，让 usage 断言确定性成立 */
const STUB_USAGE = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };

/**
 * 创建脚本假 LLM
 *
 * - **按序回放**：每次 `complete` / `stream` 调用消费下一个回合
 * - **快照在回放前记录**：超用抛错时该次请求也已留痕（可检视第 N 轮请求）
 * - **脚本用尽即抛**：消息含已调用轮次与「用例未收敛」指引——超用 = 用例写错，
 *   不静默返回空回合
 * - **回合身份确定性**：tool call id 为 `call_<回合序号>_<序内下标>`（从 1 计）
 *
 * @param turns 预设回合序列
 */
export function createScriptLLM(turns: ScriptTurn[]): ScriptedLLM {
  const requests: LLMCompleteRequest[] = [];
  let cursor = 0;

  const next = (request: LLMCompleteRequest): LLMResponse => {
    requests.push(request);
    if (cursor >= turns.length) {
      throw new Error(
        `createScriptLLM 脚本用尽（第 ${requests.length} 轮仍被调用），用例未收敛——` +
          `补齐脚本回合或修正用例让它显式结束`,
      );
    }
    const turn = turns[cursor]!;
    cursor += 1;
    const toolCalls: LLMToolCall[] | undefined = turn.toolCalls?.map((tc, idx) => ({
      id: `call_${cursor}_${idx}`,
      type: 'function',
      function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
    }));
    const message: LLMMessage = {
      role: 'assistant',
      content: turn.content ?? '',
      ...(toolCalls ? { tool_calls: toolCalls } : {}),
    };
    return {
      message,
      stopReason: toolCalls ? 'tool_calls' : 'stop',
      usage: { ...STUB_USAGE },
    };
  };

  return {
    requests,
    async complete(request) {
      return next(request);
    },
    async *stream(request): AsyncGenerator<LLMStreamChunk> {
      const res = next(request);
      if (res.message.content) yield { deltaContent: res.message.content };
      if (res.message.tool_calls) {
        yield { toolCalls: res.message.tool_calls, finishReason: 'tool_calls' };
      } else {
        yield { finishReason: 'stop', usage: res.usage };
      }
    },
  };
}
