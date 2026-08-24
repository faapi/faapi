import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AgentCore, AgentMetadata } from '../ast/extractAgentMetadata';
import type { ToolMetadata } from '../ast/extractToolMetadata';
import {
  hydrateAgentRegistry,
  clearAgentRegistry,
  getAgent,
  getAgentEntry,
  listAgents,
  asTool,
  resolveAgentTools,
  resolveSubAgents,
  type AgentToolDescriptor,
} from './agentRegistry';
import { hydrateToolRegistry, clearToolRegistry } from './toolRegistry';
import { clearSkillRegistry, upsertSkill, removeSkill } from './skillRegistry';

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
    clearSkillRegistry();
  });

  afterEach(() => {
    clearAgentRegistry();
    clearToolRegistry();
    clearSkillRegistry();
  });

  const researcher: AgentMetadata = {
    name: 'researcher',
    description: '研究助手',
    filePath: 'dist/agents/researcher/handler.js',
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
      const agent = getAgentEntry('researcher');
      expect(agent).toBeDefined();
      expect(agent!.name).toBe('researcher');
      expect(agent!.description).toBe('研究助手');
      expect(agent!.filePath).toBe('dist/agents/researcher/handler.js');
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
      const agent = getAgentEntry('writer');
      expect(agent).toBeDefined();
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
        hasRun: true,
      };
      const orchestrator: AgentMetadata = {
        name: 'orchestrator',
        filePath: 'dist/agents/orchestrator/handler.js',
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

  describe('skill fallback — DB-driven skill 自动发现', () => {
    /**
     * skillRegistry 是业务方运行时动态注册的 DB-driven skill 来源,
     * agentRegistry 的查询函数在文件 registry 未命中时 fallback 到 skillRegistry。
     * 优先级:skill 优先,文件型回退(同名时 skill 覆盖文件型 agent)。
     */
    const translator: AgentCore = {
      name: 'translator',
      description: '翻译助手',
      systemPrompt: '你是一个翻译助手',
      tools: ['translate.detect', 'translate.convert'],
      agents: [],
      model: 'gpt-4o',
      maxTurns: 5,
    };

    it('getAgent fallback 命中 skill', () => {
      upsertSkill(translator);
      // 文件 registry 没注册 translator,fallback 命中 skill
      expect(getAgent('translator')).toEqual(translator);
    });

    it('getAgent 文件 registry 命中时不查 skill', () => {
      hydrateAgentRegistry([researcher]);
      // 文件 registry 已有 researcher,即使 skill 也有同名,优先返回 skill
      // (skill 优先级更高,override 语义)
      upsertSkill({ ...researcher, systemPrompt: 'skill-override' });
      const result = getAgent('researcher')!;
      expect(result.systemPrompt).toBe('skill-override');
    });

    it('getAgent 两个 registry 都未命中返回 undefined', () => {
      expect(getAgent('nonexistent')).toBeUndefined();
    });

    it('listAgents 合并文件型 + skill,同名时 skill 覆盖', () => {
      hydrateAgentRegistry([researcher, writer]);
      upsertSkill(translator);
      // 同名时 skill 覆盖文件型
      upsertSkill({ ...researcher, systemPrompt: 'skill-override' });

      const list = listAgents();
      // researcher(被覆盖) + writer + translator = 3
      expect(list).toHaveLength(3);
      const names = list.map((a) => a.name).sort();
      expect(names).toEqual(['researcher', 'translator', 'writer']);

      // researcher 是 skill 版本(systemPrompt 被覆盖)
      const r = list.find((a) => a.name === 'researcher')!;
      expect(r.systemPrompt).toBe('skill-override');
    });

    it('listAgents 两个 registry 都空返回空数组', () => {
      expect(listAgents()).toEqual([]);
    });

    it('resolveAgentTools fallback 命中 skill 的 tools 引用', () => {
      hydrateToolRegistry([
        {
          name: 'translate.detect',
          functionName: 'detect',
          description: '检测语言',
          filePath: 'dist/tools/translate/handler.js',
        },
        {
          name: 'translate.convert',
          functionName: 'convert',
          description: '翻译',
          filePath: 'dist/tools/translate/handler.js',
        },
      ]);
      upsertSkill(translator);

      const tools = resolveAgentTools('translator');
      expect(tools).toHaveLength(2);
      expect(tools.map((t) => t.name).sort()).toEqual(['translate.convert', 'translate.detect']);
    });

    it('resolveAgentTools skill 未注册返回空数组', () => {
      expect(resolveAgentTools('nonexistent')).toEqual([]);
    });

    it('asTool fallback 命中 skill', () => {
      upsertSkill(translator);
      const tool = asTool('translator');
      expect(tool).toBeDefined();
      expect(tool!.kind).toBe('agent');
      expect(tool!.name).toBe('agent.translator');
      expect(tool!.agentName).toBe('translator');
      expect(tool!.description).toBe('翻译助手');
      expect(tool!.metadata).toEqual(translator);
    });

    it('asTool skill 未注册返回 undefined', () => {
      expect(asTool('nonexistent')).toBeUndefined();
    });

    it('removeSkill 后 agentRegistry 不再 fallback 命中', () => {
      upsertSkill(translator);
      expect(getAgent('translator')).toBeDefined();

      removeSkill('translator');
      expect(getAgent('translator')).toBeUndefined();
    });

    it('reloadAgents 不影响 skillRegistry(dev 模式安全)', () => {
      // 模拟 dev watcher 触发 reloadAgents:重新 hydrate 文件 registry
      upsertSkill(translator);
      hydrateAgentRegistry([researcher]); // 重新整体替换文件 registry

      // skillRegistry 不受影响,translator 仍可被发现
      expect(getAgent('translator')).toEqual(translator);
      expect(getAgent('researcher')).toEqual(researcher);
    });
  });
});
