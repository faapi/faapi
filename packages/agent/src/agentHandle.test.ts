import { describe, it, expect } from 'vitest';
import { Agent } from './agent';
import type { AgentHandle } from './agentHandle';
import type { AgentDeps } from './agent';
import type { AgentMetadata, ToolMetadata } from '@faapi/faapi';
import type { LLMProvider, LLMResponse, LLMStreamChunk } from './provider';

// ─── 类型级测试：Agent 满足 AgentHandle ────────────────

/** 编译期断言：Agent 可赋值给 AgentHandle（结构化类型匹配） */
function _assertAgentIsAgentHandle(agent: Agent): AgentHandle {
  return agent;
}

/** 编译期断言：AgentHandle 的方法签名与 Agent 一致 */
function _assertMethodSignatures(handle: AgentHandle): {
  run: (input: string) => Promise<unknown>;
  stream: (input: string) => AsyncIterable<unknown>;
  asTool: () => unknown;
} {
  return {
    run: handle.run,
    stream: handle.stream,
    asTool: handle.asTool,
  };
}

// ─── 运行时测试 ─────────────────────────────────────

/** 构造 mock provider */
function mockProvider(): LLMProvider {
  return {
    async complete(): Promise<LLMResponse> {
      return {
        message: { role: 'assistant', content: 'done' },
        stopReason: 'stop',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
    },
    async *stream(): AsyncIterable<LLMStreamChunk> {
      yield { deltaContent: 'done' };
      yield { finishReason: 'stop' };
    },
  };
}

/** 构造完整 AgentDeps（mock 版） */
function mockDeps(): AgentDeps {
  const agentMeta: AgentMetadata = {
    name: 'researcher',
    filePath: 'dist/agents/researcher/handler.js',
    hasConfig: true,
    hasRun: false,
    description: '研究 agent',
    systemPrompt: 'you are a researcher',
  };
  return {
    provider: mockProvider(),
    agentName: 'researcher',
    rootDir: '/project',
    getAgent: (name) => (name === 'researcher' ? agentMeta : undefined),
    getTool: () => undefined,
    resolveAgentTools: () => [] as ToolMetadata[],
    resolveSubAgents: () => [] as AgentMetadata[],
    loadToolModule: async () => ({ handler: async () => 'ok', functionName: 'fn' }),
    loadAgentModule: async () => ({ config: {}, run: undefined }),
  };
}

describe('AgentHandle', () => {
  describe('类型兼容性', () => {
    it('Agent 实例可赋值给 AgentHandle', () => {
      const agent = new Agent(mockDeps());
      const handle: AgentHandle = agent;
      expect(handle).toBe(agent);
    });

    it('AgentHandle 方法可被调用（签名兼容）', () => {
      const handle: AgentHandle = new Agent(mockDeps());
      expect(typeof handle.run).toBe('function');
      expect(typeof handle.stream).toBe('function');
      expect(typeof handle.asTool).toBe('function');
    });
  });

  describe('run()', () => {
    it('返回 ReactLoopResult（content + turns + stopReason）', async () => {
      const handle: AgentHandle = new Agent(mockDeps());
      const result = await handle.run('hello');
      expect(result.content).toBe('done');
      expect(result.turns).toBe(1);
      expect(result.stopReason).toBe('stop');
    });

    it('agent 未注册时抛 AgentError', async () => {
      const deps = mockDeps();
      deps.getAgent = () => undefined;
      const handle: AgentHandle = new Agent(deps);
      await expect(handle.run('hello')).rejects.toThrow('Agent "researcher" is not registered');
    });
  });

  describe('stream()', () => {
    it('yield ReactLoopStreamChunk（delta + done）', async () => {
      const handle: AgentHandle = new Agent(mockDeps());
      const chunks: { deltaContent?: string; done?: { content: string } }[] = [];
      for await (const chunk of handle.stream('hello')) {
        chunks.push(chunk);
      }
      expect(chunks.length).toBeGreaterThanOrEqual(1);
      const done = chunks.find((c) => c.done !== undefined);
      expect(done?.done?.content).toBe('done');
    });
  });

  describe('asTool()', () => {
    it('返回 AgentToolDescriptor（name = agent.<agentName>）', () => {
      const handle: AgentHandle = new Agent(mockDeps());
      const tool = handle.asTool();
      expect(tool).toBeDefined();
      expect(tool?.kind).toBe('agent');
      expect(tool?.name).toBe('agent.researcher');
      expect(tool?.agentName).toBe('researcher');
      expect(tool?.description).toBe('研究 agent');
    });

    it('agent 未注册时返回 undefined', () => {
      const deps = mockDeps();
      deps.getAgent = () => undefined;
      const handle: AgentHandle = new Agent(deps);
      expect(handle.asTool()).toBeUndefined();
    });
  });
});
