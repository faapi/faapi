import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { ToolMetadata } from '../ast/extractToolMetadata';
import { hydrateToolRegistry, clearToolRegistry, getTool, listTools } from './toolRegistry';

/**
 * toolRegistry 测试：单例注册表的查询 API
 *
 * 覆盖：
 * - hydrate 全量替换
 * - getTool 按名查找
 * - listTools 全量列表
 * - clear 清空
 */
describe('toolRegistry', () => {
  beforeEach(() => {
    clearToolRegistry();
  });

  afterEach(() => {
    clearToolRegistry();
  });

  const sharedTool: ToolMetadata = {
    name: 'weather.getWeather',
    functionName: 'getWeather',
    filePath: 'dist/tools/weather/handler.js',
    description: '获取天气',
    inputTypeName: 'WeatherInput',
  };

  const agentTool: ToolMetadata = {
    name: 'web-search.search',
    functionName: 'search',
    filePath: 'dist/agents/researcher/tools/web-search/handler.js',
    description: '网页搜索',
    inputTypeName: 'SearchInput',
  };

  const anotherAgentTool: ToolMetadata = {
    name: 'summarize',
    functionName: 'summarize',
    filePath: 'dist/agents/researcher/tools/summarize/handler.js',
  };

  describe('hydrateToolRegistry', () => {
    it('注册 tool 列表', () => {
      hydrateToolRegistry([sharedTool, agentTool]);

      expect(listTools()).toHaveLength(2);
      expect(getTool('weather.getWeather')).toBeDefined();
      expect(getTool('web-search.search')).toBeDefined();
    });

    it('全量替换：再次 hydrate 覆盖旧数据', () => {
      hydrateToolRegistry([sharedTool, agentTool]);
      expect(listTools()).toHaveLength(2);

      hydrateToolRegistry([anotherAgentTool]);
      expect(listTools()).toHaveLength(1);
      expect(getTool('weather.getWeather')).toBeUndefined();
      expect(getTool('summarize')).toBeDefined();
    });

    it('空数组清空注册表', () => {
      hydrateToolRegistry([sharedTool]);
      expect(listTools()).toHaveLength(1);

      hydrateToolRegistry([]);
      expect(listTools()).toHaveLength(0);
    });
  });

  describe('getTool', () => {
    it('按全名查找', () => {
      hydrateToolRegistry([sharedTool]);
      const tool = getTool('weather.getWeather');
      expect(tool).toBeDefined();
      expect(tool!.name).toBe('weather.getWeather');
      expect(tool!.functionName).toBe('getWeather');
      expect(tool!.filePath).toBe('dist/tools/weather/handler.js');
      expect(tool!.description).toBe('获取天气');
      expect(tool!.inputTypeName).toBe('WeatherInput');
    });

    it('未注册的 name 返回 undefined', () => {
      hydrateToolRegistry([sharedTool]);
      expect(getTool('nonexistent.tool')).toBeUndefined();
    });

    it('空注册表返回 undefined', () => {
      expect(getTool('any.tool')).toBeUndefined();
    });
  });

  describe('listTools', () => {
    it('返回所有已注册 tool', () => {
      hydrateToolRegistry([sharedTool, agentTool, anotherAgentTool]);
      const all = listTools();
      expect(all).toHaveLength(3);
      const names = all.map((t) => t.name);
      expect(names).toContain('weather.getWeather');
      expect(names).toContain('web-search.search');
      expect(names).toContain('summarize');
    });

    it('返回副本，修改不影响内部状态', () => {
      hydrateToolRegistry([sharedTool]);
      const all = listTools();
      all.push(agentTool);
      expect(listTools()).toHaveLength(1);
    });

    it('空注册表返回空数组', () => {
      expect(listTools()).toEqual([]);
    });
  });

  describe('clearToolRegistry', () => {
    it('清空后所有查询返回空', () => {
      hydrateToolRegistry([sharedTool, agentTool]);
      clearToolRegistry();
      expect(listTools()).toEqual([]);
      expect(getTool('weather.getWeather')).toBeUndefined();
    });
  });
});
