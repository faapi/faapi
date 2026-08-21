import type { LlmConfig } from '@faapi/faapi';
import type {
  LLMCompleteRequest,
  LLMMessage,
  LLMProvider,
  LLMResponse,
  LLMStopReason,
  LLMStreamChunk,
  LLMToolCall,
  LLMToolDefinition,
  LLMUsage,
} from '../provider';

/**
 * OpenAI 兼容 API 的 LLMProvider 实现
 *
 * 通过 `LlmConfig.baseURL` 可指向任意 OpenAI 兼容中转服务
 * （官方 OpenAI / Azure OpenAI / LiteLLM / one-api / 自建网关）。
 *
 * 详见 [openai.md](./openai.md)。
 */

/** OpenAI 默认 API 端点（未设 baseURL 时使用） */
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

/** OpenAI 已知透传字段集合（这些字段在 LlmConfig 中有专门处理,不算"额外透传"） */
const RESERVED_CONFIG_KEYS = new Set(['provider', 'apiKey', 'model', 'baseURL']);

/**
 * LLM Provider 错误
 *
 * 含 HTTP 状态码（网络错误为 `undefined`）和响应体摘要,
 * 业务方可通过 `instanceof LLMProviderError` 区分 LLM 错误与其他错误。
 */
export class LLMProviderError extends Error {
  /** HTTP 状态码（网络错误 / JSON 解析错误为 undefined） */
  readonly status?: number;
  /** 响应体摘要（前 500 字符,便于诊断） */
  readonly body?: string;

  constructor(message: string, options?: { status?: number; body?: string; cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'LLMProviderError';
    this.status = options?.status;
    this.body = options?.body;
  }
}

/** 内部存储:OpenAI chat completions 请求体（构造阶段） */
interface OpenAIRequestBody {
  model?: string;
  messages: unknown[];
  tools?: unknown[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  [key: string]: unknown;
}

/** 内部存储:OpenAI tool_call 项(非流式 + 流式统一,index 仅流式有) */
interface OpenAIToolCall {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

/** 内部存储:OpenAI usage 字段 */
interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

/** 内部存储:OpenAI chat completions 响应 */
interface OpenAIResponseJson {
  choices?: Array<{
    index?: number;
    message?: {
      role?: string;
      content?: string | null;
      tool_calls?: OpenAIToolCall[];
    };
    finish_reason?: string | null;
  }>;
  usage?: OpenAIUsage;
}

/** 内部存储:OpenAI streaming chunk */
interface OpenAIStreamChunkJson {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: OpenAIToolCall[];
    };
    finish_reason?: string | null;
  }>;
  usage?: OpenAIUsage;
}

/** tool call 累积器（stream 模式按 index 累积 args 字符串） */
interface ToolCallAccumulator {
  id?: string;
  name?: string;
  argsString: string;
}

/**
 * 创建 OpenAI 兼容 LLMProvider
 *
 * @param config LLM 提供方配置（apiKey / model / baseURL / 透传字段）
 * @returns LLMProvider 实例（含 complete + stream 方法）
 */
export function createOpenAIProvider(config: LlmConfig): LLMProvider {
  const baseURL = (config.baseURL ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const apiKey = config.apiKey;

  /** 构造 OpenAI chat completions 请求体 */
  function buildRequestBody(request: LLMCompleteRequest): OpenAIRequestBody {
    const body: OpenAIRequestBody = {
      model: request.model ?? config.model,
      messages: request.messages.map(toOpenAIMessage),
    };

    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map(toOpenAITool);
    }

    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;

    // 透传 config 额外字段（temperature / top_p / max_tokens 等,业务方在 LlmConfig 设）
    for (const key of Object.keys(config)) {
      if (RESERVED_CONFIG_KEYS.has(key)) continue;
      const value = (config as Record<string, unknown>)[key];
      if (value !== undefined && !(key in body)) {
        body[key] = value;
      }
    }

    return body;
  }

  /** 构造请求 headers */
  function buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    return headers;
  }

  /** 调 fetch,统一捕获网络错误 */
  async function safeFetch(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(url, init);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new LLMProviderError(`Network error: ${reason}`, { cause: err });
    }
  }

  /** 校验 HTTP 响应状态,非 2xx 抛 LLMProviderError */
  async function ensureOk(response: Response): Promise<string> {
    if (response.ok) return '';
    const bodyText = await response.text();
    const excerpt = bodyText.slice(0, 500);
    throw new LLMProviderError(`HTTP ${response.status}: ${excerpt}`, {
      status: response.status,
      body: excerpt,
    });
  }

  // ─── complete ──────────────────────────────────────

  async function complete(request: LLMCompleteRequest): Promise<LLMResponse> {
    const url = `${baseURL}/chat/completions`;
    const body = buildRequestBody(request);
    const init: RequestInit = {
      method: 'POST',
      headers: buildHeaders(),
      body: JSON.stringify(body),
    };

    const response = await safeFetch(url, init);
    await ensureOk(response);

    const bodyText = await response.text();
    let json: OpenAIResponseJson;
    try {
      json = JSON.parse(bodyText) as OpenAIResponseJson;
    } catch {
      const excerpt = bodyText.slice(0, 500);
      throw new LLMProviderError(`Invalid JSON response: ${excerpt}`, {
        status: response.status,
        body: excerpt,
      });
    }

    const choice = json.choices?.[0];
    const msg = choice?.message;
    if (!choice || !msg) {
      const excerpt = bodyText.slice(0, 500);
      throw new LLMProviderError('Empty choices in response', {
        status: response.status,
        body: excerpt,
      });
    }

    const content = msg.content ?? '';
    const toolCalls = parseToolCalls(msg.tool_calls, bodyText, response.status);

    return {
      message: {
        role: 'assistant',
        content,
        toolCalls,
      },
      stopReason: mapStopReason(choice.finish_reason ?? undefined),
      usage: mapUsage(json.usage),
    };
  }

  // ─── stream ──────────────────────────────────────

  async function* stream(request: LLMCompleteRequest): AsyncIterable<LLMStreamChunk> {
    const url = `${baseURL}/chat/completions`;
    const body = buildRequestBody(request);
    body.stream = true;

    const init: RequestInit = {
      method: 'POST',
      headers: buildHeaders(),
      body: JSON.stringify(body),
    };

    const response = await safeFetch(url, init);
    await ensureOk(response);

    if (!response.body) {
      throw new LLMProviderError('Response body is null (streaming unsupported)', {
        status: response.status,
      });
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    /** tool call 累积器,按 index 聚合 args 字符串 */
    const accumulators = new Map<number, ToolCallAccumulator>();
    let finishReason: LLMStopReason | undefined;
    let usage: LLMUsage | undefined;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE 事件以 \n\n 分隔
        let sep: number;
        while ((sep = buffer.indexOf('\n\n')) >= 0) {
          const eventStr = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);

          const data = extractSSEData(eventStr);
          if (data === null) continue; // 注释行 / 心跳行 / 非 data 行

          if (data === '[DONE]') {
            // emit 最终 chunk（含累积的 toolCalls + finishReason + usage）
            yield finalizeStreamChunk(accumulators, finishReason, usage);
            return;
          }

          let chunk: OpenAIStreamChunkJson;
          try {
            chunk = JSON.parse(data) as OpenAIStreamChunkJson;
          } catch {
            const excerpt = data.slice(0, 500);
            throw new LLMProviderError(`Invalid SSE chunk: ${excerpt}`, {
              status: response.status,
              body: excerpt,
            });
          }

          const delta = chunk.choices?.[0]?.delta;
          if (delta) {
            // 内容增量
            if (typeof delta.content === 'string' && delta.content.length > 0) {
              yield { deltaContent: delta.content };
            }
            // tool_calls 增量累积
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                accumulateToolCall(accumulators, tc);
              }
            }
          }

          const fr = chunk.choices?.[0]?.finish_reason;
          if (fr) finishReason = mapStopReason(fr);
          if (chunk.usage) usage = mapUsage(chunk.usage);
        }
      }

      // 流自然结束（无 [DONE]）,emit 最终 chunk
      yield finalizeStreamChunk(accumulators, finishReason, usage);
    } finally {
      reader.releaseLock();
    }
  }

  return { complete, stream };
}

// ─── 辅助函数 ──────────────────────────────────────

/** LLMMessage → OpenAI 消息格式 */
function toOpenAIMessage(msg: LLMMessage): unknown {
  const out: Record<string, unknown> = {
    role: msg.role,
    content: msg.content,
  };
  if (msg.toolCallId !== undefined) out.tool_call_id = msg.toolCallId;
  if (msg.toolCalls !== undefined && msg.toolCalls.length > 0) {
    out.tool_calls = msg.toolCalls.map((tc) => ({
      id: tc.id,
      type: 'function',
      function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
    }));
  }
  return out;
}

/** LLMToolDefinition → OpenAI tool 定义格式 */
function toOpenAITool(tool: LLMToolDefinition): unknown {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input,
    },
  };
}

/** OpenAI tool_calls 数组 → LLMToolCall[],JSON.parse 每个 arguments */
function parseToolCalls(
  toolCalls: OpenAIToolCall[] | undefined,
  bodyText: string,
  status: number,
): LLMToolCall[] | undefined {
  if (!toolCalls || toolCalls.length === 0) return undefined;

  const result: LLMToolCall[] = [];
  for (let i = 0; i < toolCalls.length; i++) {
    const tc = toolCalls[i];
    const argsStr = tc?.function?.arguments ?? '{}';
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(argsStr);
    } catch {
      const excerpt = argsStr.slice(0, 500);
      throw new LLMProviderError(`Invalid tool arguments JSON: ${excerpt}`, {
        status,
        body: bodyText.slice(0, 500),
      });
    }
    result.push({
      id: tc?.id ?? `call_${i}`,
      name: tc?.function?.name ?? '',
      arguments: args,
    });
  }
  return result;
}

/** OpenAI finish_reason → LLMStopReason */
function mapStopReason(fr: string | undefined | null): LLMStopReason {
  switch (fr) {
    case 'stop':
      return 'stop';
    case 'tool_calls':
      return 'tool_calls';
    case 'length':
      return 'length';
    case 'content_filter':
      return 'content_filter';
    default:
      return 'other';
  }
}

/** OpenAI usage → LLMUsage */
function mapUsage(u?: {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}): LLMUsage | undefined {
  if (!u) return undefined;
  return {
    promptTokens: u.prompt_tokens ?? 0,
    completionTokens: u.completion_tokens ?? 0,
    totalTokens: u.total_tokens ?? 0,
  };
}

/** 从 SSE 事件块提取 data: 行内容(多行用 \n 拼接) */
function extractSSEData(event: string): string | null {
  const dataLines: string[] = [];
  for (const line of event.split('\n')) {
    // 跳过空行 / 注释行 / 心跳行
    if (line === '' || line.startsWith(':')) continue;
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    // 其他字段(event: / id: / retry:)忽略,OpenAI 不用
  }
  if (dataLines.length === 0) return null;
  return dataLines.join('\n');
}

/** 累积 tool call chunk 到按 index 的 Map */
function accumulateToolCall(
  accumulators: Map<number, ToolCallAccumulator>,
  tc: OpenAIToolCall,
): void {
  const idx = tc.index ?? 0;
  const acc = accumulators.get(idx) ?? { argsString: '' };
  if (tc.id) acc.id = tc.id;
  if (tc.function?.name) acc.name = tc.function.name;
  if (tc.function?.arguments) acc.argsString += tc.function.arguments;
  accumulators.set(idx, acc);
}

/** 流结束时把累积器转为 LLMToolCall[] + finishReason + usage 一并 emit */
function finalizeStreamChunk(
  accumulators: Map<number, ToolCallAccumulator>,
  finishReason: LLMStopReason | undefined,
  usage: LLMUsage | undefined,
): LLMStreamChunk {
  const toolCalls: LLMToolCall[] = [];
  if (accumulators.size > 0) {
    const indices = Array.from(accumulators.keys()).sort((a, b) => a - b);
    for (const idx of indices) {
      const acc = accumulators.get(idx)!;
      // 跳过不完整(无 id 或 name)的累积,异常流不应阻止结束
      if (!acc.id || !acc.name) continue;
      let args: Record<string, unknown>;
      try {
        args = acc.argsString ? JSON.parse(acc.argsString) : {};
      } catch {
        const excerpt = acc.argsString.slice(0, 500);
        throw new LLMProviderError(`Invalid tool arguments JSON: ${excerpt}`, {
          body: excerpt,
        });
      }
      toolCalls.push({
        id: acc.id,
        name: acc.name,
        arguments: args,
      });
    }
  }

  const chunk: LLMStreamChunk = {};
  if (toolCalls.length > 0) chunk.toolCalls = toolCalls;
  if (finishReason) chunk.finishReason = finishReason;
  if (usage) chunk.usage = usage;
  return chunk;
}
