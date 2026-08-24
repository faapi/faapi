import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AgentCore } from '../ast/extractAgentMetadata';
import {
  hydrateSkillRegistry,
  clearSkillRegistry,
  upsertSkill,
  removeSkill,
  getSkill,
  listSkills,
} from './skillRegistry';

/**
 * skillRegistry 测试：运行时动态 skill 注册表
 *
 * 覆盖：
 * - 整体替换（hydrateSkillRegistry）
 * - 单条增改（upsertSkill）
 * - 单条删（removeSkill）
 * - 查询（getSkill / listSkills）
 * - 清空（clearSkillRegistry）
 *
 * 与 agentRegistry.test.ts 同构，但只测 skillRegistry 自身的存储语义，
 * 不涉及 agentRegistry fallback（fallback 行为在 agentRegistry.test.ts 测）。
 */
describe('skillRegistry', () => {
  beforeEach(() => {
    clearSkillRegistry();
  });

  afterEach(() => {
    clearSkillRegistry();
  });

  const translator: AgentCore = {
    name: 'translator',
    description: '翻译助手',
    systemPrompt: '你是一个翻译助手',
    tools: ['translate.detect', 'translate.convert'],
    agents: [],
    model: 'gpt-4o',
    maxTurns: 5,
  };

  const summarizer: AgentCore = {
    name: 'summarizer',
    description: '摘要助手',
    systemPrompt: '你是一个摘要助手',
    tools: ['text.read'],
    agents: [],
    model: 'gpt-4o-mini',
    maxTurns: 3,
  };

  describe('hydrateSkillRegistry — 整体替换', () => {
    it('空数组清空注册表', () => {
      upsertSkill(translator);
      expect(listSkills()).toHaveLength(1);

      hydrateSkillRegistry([]);
      expect(listSkills()).toHaveLength(0);
      expect(getSkill('translator')).toBeUndefined();
    });

    it('整体替换清空原有 skill', () => {
      upsertSkill(translator);
      upsertSkill(summarizer);
      expect(listSkills()).toHaveLength(2);

      // 用只有 translator 的数组整体替换,summarizer 应被清空
      hydrateSkillRegistry([translator]);
      expect(listSkills()).toHaveLength(1);
      expect(getSkill('translator')).toBeDefined();
      expect(getSkill('summarizer')).toBeUndefined();
    });

    it('同名 skill 在数组中后者覆盖前者', () => {
      const v1 = { ...translator, systemPrompt: 'v1' };
      const v2 = { ...translator, systemPrompt: 'v2' };
      hydrateSkillRegistry([v1, v2]);
      expect(getSkill('translator')!.systemPrompt).toBe('v2');
    });
  });

  describe('upsertSkill — 单条增改', () => {
    it('新增 skill', () => {
      upsertSkill(translator);
      expect(getSkill('translator')).toEqual(translator);
    });

    it('同名 skill 覆盖（更新）', () => {
      upsertSkill(translator);
      const updated = { ...translator, systemPrompt: '新的提示词', maxTurns: 8 };
      upsertSkill(updated);
      expect(getSkill('translator')).toEqual(updated);
      expect(listSkills()).toHaveLength(1); // 不重复
    });

    it('多个不同名 skill 共存', () => {
      upsertSkill(translator);
      upsertSkill(summarizer);
      expect(listSkills()).toHaveLength(2);
      expect(getSkill('translator')).toBeDefined();
      expect(getSkill('summarizer')).toBeDefined();
    });

    it('并发安全:Map.set 原子操作', () => {
      // 模拟并发 upsert,最后一次 wins
      upsertSkill({ ...translator, maxTurns: 1 });
      upsertSkill({ ...translator, maxTurns: 2 });
      upsertSkill({ ...translator, maxTurns: 3 });
      expect(getSkill('translator')!.maxTurns).toBe(3);
    });
  });

  describe('removeSkill — 单条删', () => {
    it('删除已存在的 skill', () => {
      upsertSkill(translator);
      upsertSkill(summarizer);

      removeSkill('translator');

      expect(getSkill('translator')).toBeUndefined();
      expect(getSkill('summarizer')).toBeDefined();
      expect(listSkills()).toHaveLength(1);
    });

    it('删除不存在的 skill 静默无操作', () => {
      upsertSkill(translator);
      // 不抛错,不抛错符合"幂等删除"语义
      expect(() => removeSkill('nonexistent')).not.toThrow();
      expect(listSkills()).toHaveLength(1);
    });

    it('删除空字符串 name 不抛错', () => {
      // 防御性测试:DB skill 可能误传空字符串
      expect(() => removeSkill('')).not.toThrow();
    });
  });

  describe('getSkill — 查询单个', () => {
    it('命中返回 metadata', () => {
      upsertSkill(translator);
      expect(getSkill('translator')).toEqual(translator);
    });

    it('未命中返回 undefined', () => {
      expect(getSkill('nonexistent')).toBeUndefined();
    });

    it('空 registry 查询返回 undefined', () => {
      expect(getSkill('translator')).toBeUndefined();
    });
  });

  describe('listSkills — 列表查询', () => {
    it('空 registry 返回空数组', () => {
      expect(listSkills()).toEqual([]);
    });

    it('返回所有已注册 skill 的副本', () => {
      hydrateSkillRegistry([translator, summarizer]);
      const list = listSkills();
      expect(list).toHaveLength(2);
      expect(list.map((s) => s.name).sort()).toEqual(['summarizer', 'translator']);
    });

    it('返回副本,修改不影响内部状态', () => {
      hydrateSkillRegistry([translator]);
      const list = listSkills();
      list.push(summarizer);
      expect(listSkills()).toHaveLength(1);
    });
  });

  describe('clearSkillRegistry — 清空', () => {
    it('清空所有 skill', () => {
      hydrateSkillRegistry([translator, summarizer]);
      expect(listSkills()).toHaveLength(2);

      clearSkillRegistry();

      expect(listSkills()).toEqual([]);
      expect(getSkill('translator')).toBeUndefined();
      expect(getSkill('summarizer')).toBeUndefined();
    });

    it('清空后再 upsert 仍可工作', () => {
      hydrateSkillRegistry([translator]);
      clearSkillRegistry();
      upsertSkill(summarizer);
      expect(getSkill('summarizer')).toBeDefined();
      expect(listSkills()).toHaveLength(1);
    });
  });

  describe('DB skill 的特殊字段约定', () => {
    it('运行时携带 systemPrompt / tools / model / maxTurns', () => {
      upsertSkill(translator);
      const skill = getSkill('translator')!;
      expect(skill.systemPrompt).toBe('你是一个翻译助手');
      expect(skill.tools).toEqual(['translate.detect', 'translate.convert']);
      expect(skill.model).toBe('gpt-4o');
      expect(skill.maxTurns).toBe(5);
    });
  });
});
