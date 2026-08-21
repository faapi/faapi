import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AgentMetadata } from '../ast/extractAgentMetadata';
import type { ToolMetadata } from '../ast/extractToolMetadata';
import {
  hydrateAgentRegistry,
  clearAgentRegistry,
  getAgent,
  listAgents,
  asTool,
  resolveAgentTools,
  resolveSubAgents,
  type AgentToolDescriptor,
} from './agentRegistry';
import { hydrateToolRegistry, clearToolRegistry } from './toolRegistry';

/**
 * agentRegistry 测试：单例注册表的查询 API
 *
 * 覆盖：
 * - Phase 1.9 基础：hydrate / getAgent / listAgents / clear
 * - Phase 2.2 扩展：asTool / resolveAgentTools / resolveSubAgents
 *
 * resolveAgentTools 跨注册表依赖 toolRegistry，测试中同步水合两个注册表。
 */
describe('agentRegistry', () => {
  beforeEach(() => {
    clearAgentRegistry();
    clearToolRegistry();
  });

  afterEach(() => {
    clearAgentRegistry();
    clearToolRegistry();
  });

  const researcher: AgentMetadata = {
    name: 'researcher',
    description: '研究助手',
    filePath: 'dist/agents/researcher/handler.js',
    hasConfig: true,
    hasRun: false,
    systemPrompt: 'You are a researcher',
    tools: ['web-search.search'],
    agents: ['writer'],
    model: 'gpt-4',
    maxTurns: 10,
  };

  const writer: AgentMetadata = {
    name: 'writer',
    description: '写作助手',
    filePath: 'dist/agents/writer/handler.js',
    hasConfig: false,
    hasRun: true,
  };

  const sharedWeather: ToolMetadata = {
    name: 'weather.getWeather',
    functionName: 'getWeather',
    filePath: 'dist/tools/weather/handler.js',
    description: '获取天气',
    inputTypeName: 'WeatherInput',
  };

  const researcherWebSearch: ToolMetadata = {
    name: 'web-search.search',
    functionName: 'search',
    filePath: 'dist/agents/researcher/tools/web-search/handler.js',
    description: '网页搜索',
    inputTypeName: 'SearchInput',
  };

  const researcherSummarize: ToolMetadata = {
    name: 'summarize',
    functionName: 'summarize',
    filePath: 'dist/agents/researcher/tools/summarize/handler.js',
  };

  describe('hydrateAgentRegistry', () => {
    it('注册 agent 列表', () => {
      hydrateAgentRegistry([researcher, writer]);

      expect(listAgents()).toHaveLength(2);
      expect(getAgent('researcher')).toBeDefined();
      expect(getAgent('writer')).toBeDefined();
    });

    it('全量替换：再次 hydrate 覆盖旧数据', () => {
      hydrateAgentRegistry([researcher, writer]);
      expect(listAgents()).toHaveLength(2);

      hydrateAgentRegistry([writer]);
      expect(listAgents()).toHaveLength(1);
      expect(getAgent('researcher')).toBeUndefined();
      expect(getAgent('writer')).toBeDefined();
    });

    it('空数组清空注册表', () => {
      hydrateAgentRegistry([researcher]);
      expect(listAgents()).toHaveLength(1);

      hydrateAgentRegistry([]);
      expect(listAgents()).toHaveLength(0);
    });
  });

  describe('getAgent', () => {
    it('按名查找', () => {
      hydrateAgentRegistry([researcher]);
      const agent = getAgent('researcher');
      expect(agent).toBeDefined();
      expect(agent!.name).toBe('researcher');
      expect(agent!.description).toBe('研究助手');
      expect(agent!.filePath).toBe('dist/agents/researcher/handler.js');
      expect(agent!.hasConfig).toBe(true);
      expect(agent!.hasRun).toBe(false);
      expect(agent!.systemPrompt).toBe('You are a researcher');
      expect(agent!.tools).toEqual(['web-search.search']);
      expect(agent!.agents).toEqual(['writer']);
      expect(agent!.model).toBe('gpt-4');
      expect(agent!.maxTurns).toBe(10);
    });

    it('未注册的 name 返回 undefined', () => {
      hydrateAgentRegistry([researcher]);
      expect(getAgent('nonexistent')).toBeUndefined();
    });

    it('空注册表返回 undefined', () => {
      expect(getAgent('any-agent')).toBeUndefined();
    });

    it('查找仅 hasRun 的 agent', () => {
      hydrateAgentRegistry([writer]);
      const agent = getAgent('writer');
      expect(agent).toBeDefined();
      expect(agent!.hasConfig).toBe(false);
      expect(agent!.hasRun).toBe(true);
      expect(agent!.systemPrompt).toBeUndefined();
    });
  });

  describe('listAgents', () => {
    it('返回所有已注册 agent', () => {
      hydrateAgentRegistry([researcher, writer]);
      const all = listAgents();
      expect(all).toHaveLength(2);
      const names = all.map((a) => a.name);
      expect(names).toContain('researcher');
      expect(names).toContain('writer');
    });

    it('返回副本，修改不影响内部状态', () => {
      hydrateAgentRegistry([researcher]);
      const all = listAgents();
      all.push(writer);
      expect(listAgents()).toHaveLength(1);
    });

    it('空注册表返回空数组', () => {
      expect(listAgents()).toEqual([]);
    });
  });

  describe('clearAgentRegistry', () => {
    it('清空后所有查询返回空', () => {
      hydrateAgentRegistry([researcher, writer]);
      clearAgentRegistry();
      expect(listAgents()).toEqual([]);
      expect(getAgent('researcher')).toBeUndefined();
    });
  });

  describe('asTool (Phase 2.2)', () => {
    it('把 agent 包装为 AgentToolDescriptor', () => {
      hydrateAgentRegistry([researcher]);
      const tool = asTool('researcher');
      expect(tool).toBeDefined();
      expect(tool!.kind).toBe('agent');
      expect(tool!.name).toBe('agent.researcher');
      expect(tool!.agentName).toBe('researcher');
      expect(tool!.description).toBe('研究助手');
      expect(tool!.metadata).toBe(researcher);
    });

    it('metadata 持有完整 AgentMetadata 引用（同一对象）', () => {
      hydrateAgentRegistry([researcher]);
      const tool = asTool('researcher');
      expect(tool!.metadata).toBe(getAgent('researcher'));
    });

    it('未注册的 agent 返回 undefined', () => {
      hydrateAgentRegistry([researcher]);
      expect(asTool('nonexistent')).toBeUndefined();
    });

    it('空注册表返回 undefined', () => {
      expect(asTool('any-agent')).toBeUndefined();
    });

    it('description 为 undefined 的 agent 透传 undefined', () => {
      const noDesc: AgentMetadata = {
        name: 'plain',
        filePath: 'dist/agents/plain/handler.js',
        hasConfig: false,
        hasRun: true,
      };
      hydrateAgentRegistry([noDesc]);
      const tool = asTool('plain');
      expect(tool).toBeDefined();
      expect(tool!.description).toBeUndefined();
    });

    it('name 加 agent. 前缀避免与常规 tool 冲突', () => {
      hydrateAgentRegistry([researcher]);
      const tool = asTool('researcher');
      expect(tool!.name.startsWith('agent.')).toBe(true);
    });
  });

  describe('resolveAgentTools (Phase 2.2)', () => {
    it('返回 agent.tools 显式声明的 tool', () => {
      hydrateAgentRegistry([researcher]);
      hydrateToolRegistry([sharedWeather, researcherWebSearch, researcherSummarize]);

      const tools = resolveAgentTools('researcher');
      expect(tools).toHaveLength(1);
      expect(tools[0]!.name).toBe('web-search.search');
    });

    it('tools 引用其他 tool', () => {
      // writer 通过 tools 引用 researcher 的 web-search.search
      const writerWithTools: AgentMetadata = {
        name: 'writer',
        filePath: 'dist/agents/writer/handler.js',
        hasConfig: true,
        hasRun: false,
        tools: ['web-search.search'],
      };
      hydrateAgentRegistry([writerWithTools, researcher]);
      hydrateToolRegistry([sharedWeather, researcherWebSearch]);

      const tools = resolveAgentTools('writer');
      expect(tools).toHaveLength(1);
      expect(tools[0]!.name).toBe('web-search.search');
    });

    it('tools 中未注册的 tool 名静默跳过', () => {
      const agent: AgentMetadata = {
        name: 'researcher',
        filePath: 'dist/agents/researcher/handler.js',
        hasConfig: true,
        hasRun: false,
        tools: ['nonexistent.tool', 'weather.getWeather'],
      };
      hydrateAgentRegistry([agent]);
      hydrateToolRegistry([sharedWeather]);

      const tools = resolveAgentTools('researcher');
      expect(tools).toHaveLength(1);
      expect(tools[0]!.name).toBe('weather.getWeather');
    });

    it('agent 无 tools 时返回空数组', () => {
      hydrateAgentRegistry([writer]); // writer 无 tools
      hydrateToolRegistry([sharedWeather, researcherWebSearch]);

      const tools = resolveAgentTools('writer');
      expect(tools).toHaveLength(0);
    });

    it('未注册的 agent 返回空数组', () => {
      hydrateToolRegistry([sharedWeather]);
      expect(resolveAgentTools('nonexistent')).toEqual([]);
    });

    it('空注册表返回空数组', () => {
      hydrateToolRegistry([sharedWeather]);
      expect(resolveAgentTools('researcher')).toEqual([]);
    });

    it('toolRegistry 为空时返回空数组', () => {
      hydrateAgentRegistry([researcher]);
      expect(resolveAgentTools('researcher')).toEqual([]);
    });

    it('返回副本，修改不影响内部状态', () => {
      hydrateAgentRegistry([researcher]);
      hydrateToolRegistry([researcherWebSearch]);
      const tools = resolveAgentTools('researcher');
      tools.push(sharedWeather);
      expect(resolveAgentTools('researcher')).toHaveLength(1);
    });

    it('agent.tools 引用其他 agent 的 tool', () => {
      const agent: AgentMetadata = {
        name: 'writer',
        filePath: 'dist/agents/writer/handler.js',
        hasConfig: true,
        hasRun: false,
        tools: ['web-search.search'],
      };
      hydrateAgentRegistry([agent]);
      hydrateToolRegistry([sharedWeather, researcherWebSearch]);

      const tools = resolveAgentTools('writer');
      expect(tools).toHaveLength(1);
      expect(tools[0]!.name).toBe('web-search.search');
    });
  });

  describe('resolveSubAgents (Phase 2.2)', () => {
    it('从 agents 字段解析子 agent', () => {
      hydrateAgentRegistry([researcher, writer]);
      // researcher.agents = ['writer']
      const subs = resolveSubAgents('researcher');
      expect(subs).toHaveLength(1);
      expect(subs[0]!.name).toBe('writer');
    });

    it('返回 AgentMetadata 引用（同一对象）', () => {
      hydrateAgentRegistry([researcher, writer]);
      const subs = resolveSubAgents('researcher');
      expect(subs[0]).toBe(getAgent('writer'));
    });

    it('agents 字段未设置时返回空数组', () => {
      hydrateAgentRegistry([writer]); // writer 无 agents
      expect(resolveSubAgents('writer')).toEqual([]);
    });

    it('agents 含未注册的 agent 名时跳过', () => {
      const agent: AgentMetadata = {
        name: 'orchestrator',
        filePath: 'dist/agents/orchestrator/handler.js',
        hasConfig: true,
        hasRun: false,
        agents: ['writer', 'nonexistent'],
      };
      hydrateAgentRegistry([agent, writer]);
      const subs = resolveSubAgents('orchestrator');
      expect(subs).toHaveLength(1);
      expect(subs[0]!.name).toBe('writer');
    });

    it('未注册的 agent 返回空数组', () => {
      hydrateAgentRegistry([writer]);
      expect(resolveSubAgents('nonexistent')).toEqual([]);
    });

    it('空注册表返回空数组', () => {
      expect(resolveSubAgents('any-agent')).toEqual([]);
    });

    it('返回副本，修改不影响内部状态', () => {
      hydrateAgentRegistry([researcher, writer]);
      const subs = resolveSubAgents('researcher');
      subs.push(researcher);
      expect(resolveSubAgents('researcher')).toHaveLength(1);
    });

    it('多 sub-agent 全部返回', () => {
      const reviewer: AgentMetadata = {
        name: 'reviewer',
        filePath: 'dist/agents/reviewer/handler.js',
        hasConfig: false,
        hasRun: true,
      };
      const orchestrator: AgentMetadata = {
        name: 'orchestrator',
        filePath: 'dist/agents/orchestrator/handler.js',
        hasConfig: true,
        hasRun: false,
        agents: ['researcher', 'writer', 'reviewer'],
      };
      hydrateAgentRegistry([orchestrator, researcher, writer, reviewer]);
      const subs = resolveSubAgents('orchestrator');
      expect(subs).toHaveLength(3);
      const names = subs.map((a) => a.name);
      expect(names).toContain('researcher');
      expect(names).toContain('writer');
      expect(names).toContain('reviewer');
    });
  });

  describe('AgentToolDescriptor 类型', () => {
    it('字段结构完整', () => {
      hydrateAgentRegistry([researcher]);
      const tool = asTool('researcher')!;
      const _: AgentToolDescriptor = tool;
      expect(_.kind).toBe('agent');
      expect(_.name).toBe('agent.researcher');
      expect(_.agentName).toBe('researcher');
      expect(_.description).toBe('研究助手');
      expect(_.metadata).toBe(researcher);
    });
  });
});
