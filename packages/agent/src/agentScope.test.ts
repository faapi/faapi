import { describe, it, expect } from 'vitest';
import { Agent } from './agent';
import { getAgentScope, type AgentScope } from './agentScope';
import { reactLoop } from './reactLoop';
import type { AgentDeps } from './agent';
import type { AgentCore, ToolMetadata, ToolModule } from '@faapi/faapi';
import type {
  LLMProvider,
  LLMResponse,
  LLMStreamChunk,
  LLMStopReason,
  LLMToolCall,
} from './provider';

/**
 * 执行作用域（getAgentScope）行为定义——详见 [agentScope.md](./agentScope.md)
 *
 * mock 策略：provider 按 system prompt 中的标记路由到各 agent 的脚本队列
 * （每个 agent 有独立 systemPrompt `SYS:<name>`），与调用到达顺序无关——
 * 并发派发（Promise.all 路径）下脚本不会被串号，归属断言因此确定。
 */

// ─── Mock 数据构造器 ─────────────────────────────────

/** 构造 AgentCore（systemPrompt 兼作 provider 路由标记 `SYS:<name>`） */
function agentMeta(opts: { name: string; tools?: string[]; agents?: string[] }): AgentCore {
  return {
    name: opts.name,
    description: `agent ${opts.name}`,
    systemPrompt: `SYS:${opts.name}`,
    tools: opts.tools,
    agents: opts.agents,
    model: 'gpt-4o',
  };
}

/** 构造 ToolMetadata */
function toolMeta(name: string): ToolMetadata {
  return {
    name,
    functionName: name,
    description: 'record current agent scope',
    filePath: 'dist/tools/scope/handler.js',
  };
}

/** 构造规范形 LLMToolCall */
function toolCall(id: string, name: string): LLMToolCall {
  return { id, type: 'function', function: { name, arguments: '{}' } };
}

/** 构造 LLMResponse（complete 模式） */
function llmResponse(opts: { content?: string; toolCalls?: LLMToolCall[] }): LLMResponse {
  return {
    message: {
      role: 'assistant',
      content: opts.content ?? '',
      ...(opts.toolCalls ? { tool_calls: opts.toolCalls } : {}),
    },
    stopReason: opts.toolCalls ? 'tool_calls' : 'stop',
  };
}

/** 构造流式 turn：增量 + 可选 tool 调用收尾 */
function streamTurn(opts: {
  content?: string;
  toolCalls?: LLMToolCall[];
  finalContent?: string;
}): LLMStreamChunk[] {
  const chunks: LLMStreamChunk[] = [];
  if (opts.content) chunks.push({ deltaContent: opts.content });
  if (opts.toolCalls) {
    chunks.push({ toolCalls: opts.toolCalls, finishReason: 'tool_calls' });
  } else {
    chunks.push({
      deltaContent: opts.finalContent ?? 'done',
      finishReason: 'stop' satisfies LLMStopReason,
    });
  }
  return chunks;
}

/** 收集 async iterable 到数组 */
async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of iter) {
    result.push(item);
  }
  return result;
}

/**
 * 按 system prompt 标记路由的非流式 mock provider——每个 agent 独立脚本队列，
 * 并发派发时脚本不串号
 */
function createRoutingProvider(scripts: Record<string, LLMResponse[]>): LLMProvider {
  const queues = new Map(Object.entries(scripts).map(([k, v]) => [k, [...v]]));
  return {
    complete: async (request) => {
      const system = request.messages.find((m) => m.role === 'system')?.content ?? '';
      const key = [...queues.keys()].find((k) => system.includes(k));
      if (!key) throw new Error(`no script matches system prompt: ${system}`);
      const res = queues.get(key)!.shift();
      if (!res) throw new Error(`script exhausted for ${key}`);
      return res;
    },
    stream: () => {
      throw new Error('stream not mocked');
    },
  };
}

/** 按 system prompt 标记路由的流式 mock provider */
function createRoutingStreamProvider(scripts: Record<string, LLMStreamChunk[][]>): LLMProvider {
  const queues = new Map(Object.entries(scripts).map(([k, v]) => [k, [...v]]));
  return {
    complete: () => {
      throw new Error('complete not mocked');
    },
    stream: async function* (request) {
      const system = request.messages.find((m) => m.role === 'system')?.content ?? '';
      const key = [...queues.keys()].find((k) => system.includes(k));
      if (!key) throw new Error(`no script matches system prompt: ${system}`);
      const turn = queues.get(key)!.shift();
      if (!turn) throw new Error(`script exhausted for ${key}`);
      for (const chunk of turn) {
        yield chunk;
      }
    },
  };
}

/**
 * 构造 agent 树的 AgentDeps——agents 声明 name → { tools, agents }，
 * 全部 agent 共享 loadToolModuleImpl（recorder 从中读取作用域）
 */
function createTreeDeps(opts: {
  provider: LLMProvider;
  agents: Record<string, { tools?: string[]; agents?: string[] }>;
  tools: ToolMetadata[];
  loadToolModuleImpl: (filePath: string, functionName: string) => Promise<ToolModule>;
}): AgentDeps {
  const declarations = opts.agents;
  return {
    providers: new Map([['openai', opts.provider]]),
    llms: {
      openai: { provider: 'openai', apiKey: 'test-key', models: { 'gpt-4o': {} } },
    },
    rootDir: '/project',
    getAgent: (name) =>
      declarations[name]
        ? agentMeta({ name, tools: declarations[name]!.tools, agents: declarations[name]!.agents })
        : undefined,
    getAgentEntry: () => undefined,
    getTool: (name) => opts.tools.find((t) => t.name === name),
    resolveAgentTools: (name) => {
      const toolNames = declarations[name]?.tools ?? [];
      return opts.tools.filter((t) => toolNames.includes(t.name));
    },
    resolveSubAgents: (name) =>
      (declarations[name]?.agents ?? []).map((sub) => ({
        ...agentMeta({ name: sub }),
        agents: declarations[sub]?.agents,
        tools: declarations[sub]?.tools,
      })),
    loadToolModule: opts.loadToolModuleImpl,
  };
}

/** 作用域 recorder：记录 tool 执行时读到的 scope（await 前后各一份） */
function createScopeRecorder() {
  const seen: AgentScope[] = [];
  const seenAfterAwait: AgentScope[] = [];
  const loadToolModuleImpl = async (): Promise<ToolModule> => ({
    functionName: 'scope_record',
    handler: async () => {
      const sync = getAgentScope();
      if (sync) seen.push({ ...sync });
      // 模拟 tool 内部深层的 async 调用（DAO 查询）后再读
      await new Promise((r) => setTimeout(r, 1));
      const after = getAgentScope();
      if (after) seenAfterAwait.push({ ...after });
      return 'rec';
    },
  });
  return { seen, seenAfterAwait, loadToolModuleImpl };
}

// ─── 非流式路径 ──────────────────────────────────────

describe('getAgentScope', () => {
  it('根 agent：tool 执行层可读，await 之后（深层 async 调用后）仍正确，run 结束后无泄漏', async () => {
    const recorder = createScopeRecorder();
    const provider = createRoutingProvider({
      root: [
        llmResponse({ toolCalls: [toolCall('t1', 'scope_record')] }),
        llmResponse({ content: 'done' }),
      ],
    });
    const agent = new Agent(
      createTreeDeps({
        provider,
        agents: { root: { tools: ['scope_record'] } },
        tools: [toolMeta('scope_record')],
        loadToolModuleImpl: recorder.loadToolModuleImpl,
      }),
    );

    const result = await agent.run('hi', { agent: 'root' });

    expect(result.content).toBe('done');
    expect(recorder.seen).toEqual([{ agentName: 'root', depth: 1 }]);
    expect(recorder.seenAfterAwait).toEqual([{ agentName: 'root', depth: 1 }]);
    expect(getAgentScope()).toBeUndefined();
  });

  it('子→孙逐层：agentName 与 depth 逐层正确（根 1 / 子 2 / 孙 3），根在派发返回后仍读自己的作用域', async () => {
    const recorder = createScopeRecorder();
    const provider = createRoutingProvider({
      root: [
        llmResponse({ toolCalls: [toolCall('t1', 'agent-mid')] }),
        llmResponse({ toolCalls: [toolCall('t2', 'scope_record')] }),
        llmResponse({ content: 'done' }),
      ],
      mid: [
        llmResponse({ toolCalls: [toolCall('m1', 'agent-leaf')] }),
        llmResponse({ content: 'mid done' }),
      ],
      leaf: [
        llmResponse({ toolCalls: [toolCall('l1', 'scope_record')] }),
        llmResponse({ content: 'leaf done' }),
      ],
    });
    const agent = new Agent(
      createTreeDeps({
        provider,
        agents: {
          root: { agents: ['mid'], tools: ['scope_record'] },
          mid: { agents: ['leaf'] },
          leaf: { tools: ['scope_record'] },
        },
        tools: [toolMeta('scope_record')],
        loadToolModuleImpl: recorder.loadToolModuleImpl,
      }),
    );

    await agent.run('hi', { agent: 'root' });

    // leaf 的 record 先于 root 的 record（root 等 mid 返回后才执行自己的 record）
    expect(recorder.seen).toEqual([
      { agentName: 'leaf', depth: 3 },
      { agentName: 'root', depth: 1 },
    ]);
    expect(recorder.seenAfterAwait).toEqual([
      { agentName: 'leaf', depth: 3 },
      { agentName: 'root', depth: 1 },
    ]);
  });

  it('并发归属阴性对照：同轮双 sub 派发（Promise.all 路径）两分支读到的 scope 互不串', async () => {
    const recorder = createScopeRecorder();
    const provider = createRoutingProvider({
      root: [
        llmResponse({ toolCalls: [toolCall('t1', 'agent-subA'), toolCall('t2', 'agent-subB')] }),
        llmResponse({ content: 'done' }),
      ],
      subA: [
        llmResponse({ toolCalls: [toolCall('a1', 'scope_record')] }),
        llmResponse({ content: 'a done' }),
      ],
      subB: [
        llmResponse({ toolCalls: [toolCall('b1', 'scope_record')] }),
        llmResponse({ content: 'b done' }),
      ],
    });
    const agent = new Agent(
      createTreeDeps({
        provider,
        agents: {
          root: { agents: ['subA', 'subB'] },
          subA: { tools: ['scope_record'] },
          subB: { tools: ['scope_record'] },
        },
        tools: [toolMeta('scope_record')],
        loadToolModuleImpl: recorder.loadToolModuleImpl,
      }),
    );

    await agent.run('hi', { agent: 'root' });

    // 恰两条记录，各归各的 sub——无 root 串入、无 A/B 张冠李戴
    expect(recorder.seen).toHaveLength(2);
    expect(recorder.seen).toContainEqual({ agentName: 'subA', depth: 2 });
    expect(recorder.seen).toContainEqual({ agentName: 'subB', depth: 2 });
    expect(recorder.seenAfterAwait).toHaveLength(2);
    expect(recorder.seenAfterAwait).toContainEqual({ agentName: 'subA', depth: 2 });
    expect(recorder.seenAfterAwait).toContainEqual({ agentName: 'subB', depth: 2 });
  });

  it('非 agent 链返回 undefined：模块顶层、直调 reactLoop 的 tool 执行层均无作用域', async () => {
    expect(getAgentScope()).toBeUndefined();

    // 直调 reactLoop（不经 Agent.run）不挂作用域——挂载点在 Agent 入口
    const directSeen: (AgentScope | undefined)[] = [];
    const provider = createRoutingProvider({
      root: [
        llmResponse({ toolCalls: [toolCall('t1', 'scope_record')] }),
        llmResponse({ content: 'done' }),
      ],
    });
    await reactLoop('hi', {
      provider,
      systemPrompt: 'SYS:root',
      model: 'gpt-4o',
      executeTool: async () => {
        directSeen.push(getAgentScope());
        return 'rec';
      },
    });
    expect(directSeen).toEqual([undefined]);
  });
});

// ─── 流式路径 ────────────────────────────────────────

describe('getAgentScope（stream）', () => {
  it('根 agent：tool 执行层可读，chunk 原样转发不丢', async () => {
    const recorder = createScopeRecorder();
    const provider = createRoutingStreamProvider({
      root: [
        streamTurn({ content: '.', toolCalls: [toolCall('t1', 'scope_record')] }),
        streamTurn({ finalContent: 'ok' }),
      ],
    });
    const agent = new Agent(
      createTreeDeps({
        provider,
        agents: { root: { tools: ['scope_record'] } },
        tools: [toolMeta('scope_record')],
        loadToolModuleImpl: recorder.loadToolModuleImpl,
      }),
    );

    const chunks = await collect(agent.stream('hi', { agent: 'root' }));

    expect(recorder.seen).toEqual([{ agentName: 'root', depth: 1 }]);
    expect(recorder.seenAfterAwait).toEqual([{ agentName: 'root', depth: 1 }]);
    // chunk 转发完整：两轮 delta + toolCall + toolResult + done
    expect(chunks.filter((c) => c.deltaContent).map((c) => c.deltaContent)).toEqual(['.', 'ok']);
    expect(chunks.some((c) => c.toolCall?.name === 'scope_record')).toBe(true);
    expect(chunks.some((c) => c.toolResult?.name === 'scope_record')).toBe(true);
    expect(chunks.at(-1)?.done?.content).toBe('ok');
    expect(getAgentScope()).toBeUndefined();
  });

  it('并发归属阴性对照（流式）：同轮双 sub 派发两分支读到的 scope 互不串', async () => {
    const recorder = createScopeRecorder();
    const provider = createRoutingStreamProvider({
      root: [
        streamTurn({ toolCalls: [toolCall('t1', 'agent-subA'), toolCall('t2', 'agent-subB')] }),
        streamTurn({ finalContent: 'done' }),
      ],
      subA: [
        streamTurn({ toolCalls: [toolCall('a1', 'scope_record')] }),
        streamTurn({ finalContent: 'a' }),
      ],
      subB: [
        streamTurn({ toolCalls: [toolCall('b1', 'scope_record')] }),
        streamTurn({ finalContent: 'b' }),
      ],
    });
    const agent = new Agent(
      createTreeDeps({
        provider,
        agents: {
          root: { agents: ['subA', 'subB'] },
          subA: { tools: ['scope_record'] },
          subB: { tools: ['scope_record'] },
        },
        tools: [toolMeta('scope_record')],
        loadToolModuleImpl: recorder.loadToolModuleImpl,
      }),
    );

    await collect(agent.stream('hi', { agent: 'root' }));

    expect(recorder.seen).toHaveLength(2);
    expect(recorder.seen).toContainEqual({ agentName: 'subA', depth: 2 });
    expect(recorder.seen).toContainEqual({ agentName: 'subB', depth: 2 });
    expect(recorder.seenAfterAwait).toContainEqual({ agentName: 'subA', depth: 2 });
    expect(recorder.seenAfterAwait).toContainEqual({ agentName: 'subB', depth: 2 });
  });

  it('消费方提前中断：内层迭代器收尾，不抛错', async () => {
    const recorder = createScopeRecorder();
    const provider = createRoutingStreamProvider({
      root: [
        streamTurn({ content: 'a', toolCalls: [toolCall('t1', 'scope_record')] }),
        streamTurn({ finalContent: 'ok' }),
      ],
    });
    const agent = new Agent(
      createTreeDeps({
        provider,
        agents: { root: { tools: ['scope_record'] } },
        tools: [toolMeta('scope_record')],
        loadToolModuleImpl: recorder.loadToolModuleImpl,
      }),
    );

    for await (const chunk of agent.stream('hi', { agent: 'root' })) {
      if (chunk.deltaContent) break;
    }

    expect(recorder.seen).toEqual([]); // tool 未执行到即中断
    expect(getAgentScope()).toBeUndefined();
  });
});
