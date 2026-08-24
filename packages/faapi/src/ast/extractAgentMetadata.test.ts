import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProgram } from './createProgram';
import { extractAgentMetadata, type AgentPathMeta } from './extractAgentMetadata';

describe('extractAgentMetadata', () => {
  let tempDir: string;
  let tempFile: string;

  beforeEach(() => {
    tempDir = join(
      tmpdir(),
      `faapi-test-agent-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tempDir, { recursive: true });
    tempFile = join(tempDir, 'handler.ts');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** 默认 pathMeta（researcher agent） */
  const meta: AgentPathMeta = {
    name: 'researcher',
    filePath: 'src/agents/researcher/handler.ts',
    hasRun: false,
  };

  /** 写源码 + 提取 */
  function extract(source: string, pathMeta: AgentPathMeta = meta) {
    writeFileSync(tempFile, source, 'utf-8');
    const program = createProgram(tempFile);
    return extractAgentMetadata(program, tempFile, pathMeta);
  }

  describe('JSDoc 提取', () => {
    it('提取单行 JSDoc 描述（config 上）', () => {
      const result = extract(`/** 研究员 agent */\nexport const config = { systemPrompt: 'x' };\n`);
      expect(result).not.toBeNull();
      expect(result!.description).toBe('研究员 agent');
    });

    it('提取多行 JSDoc 描述（保留换行）', () => {
      const result = extract(
        `/**\n * 研究员 agent\n * 负责搜索和总结\n */\nexport const config = {};\n`,
      );
      expect(result).not.toBeNull();
      expect(result!.description).toBe('研究员 agent\n负责搜索和总结');
    });

    it('提取带 @agent 标签的 JSDoc 首段描述', () => {
      const result = extract(
        `/**\n * 研究员\n * @agent researcher\n */\nexport const config = {};\n`,
      );
      expect(result).not.toBeNull();
      expect(result!.description).toBe('研究员');
    });

    it('无 JSDoc 时 description 为 undefined', () => {
      const result = extract(`export const config = {};\n`);
      expect(result).not.toBeNull();
      expect(result!.description).toBeUndefined();
    });

    it('JSDoc 只有标签无自由文本时 description 为 undefined', () => {
      const result = extract(`/** @agent researcher */\nexport const config = {};\n`);
      expect(result).not.toBeNull();
      expect(result!.description).toBeUndefined();
    });

    it('无 config 时从 run 提取 JSDoc', () => {
      const result = extract(`/** 自定义 agent */\nexport function run(input) { return 'ok'; }\n`, {
        ...meta,
        hasRun: true,
      });
      expect(result).not.toBeNull();
      expect(result!.description).toBe('自定义 agent');
    });

    it('config 和 run 都无 JSDoc 时 description 为 undefined', () => {
      const result = extract(
        `export const config = {};\nexport function run() { return 'ok'; }\n`,
        { ...meta, hasRun: true },
      );
      expect(result).not.toBeNull();
      expect(result!.description).toBeUndefined();
    });
  });

  describe('@agent 覆盖名', () => {
    it('提取 @agent 标签覆盖名', () => {
      const result = extract(`/** @agent super-researcher */\nexport const config = {};\n`);
      expect(result).not.toBeNull();
      expect(result!.name).toBe('super-researcher');
    });

    it('提取带花括号的 @agent 标签值', () => {
      const result = extract(`/** @agent {super-researcher} */\nexport const config = {};\n`);
      expect(result).not.toBeNull();
      expect(result!.name).toBe('super-researcher');
    });

    it('描述 + @agent 标签共存', () => {
      const result = extract(
        `/**\n * 研究员\n * @agent super-researcher\n */\nexport const config = {};\n`,
      );
      expect(result).not.toBeNull();
      expect(result!.name).toBe('super-researcher');
      expect(result!.description).toBe('研究员');
    });

    it('无 @agent 标签时回退到 pathMeta.name', () => {
      const result = extract(`/** 研究员 */\nexport const config = {};\n`);
      expect(result).not.toBeNull();
      expect(result!.name).toBe('researcher');
    });

    it('@agent 标签无值时回退到 pathMeta.name', () => {
      const result = extract(`/** @agent */\nexport const config = {};\n`);
      expect(result).not.toBeNull();
      expect(result!.name).toBe('researcher');
    });
  });

  describe('config 块字段提取（对象字面量）', () => {
    it('提取 systemPrompt（字符串）', () => {
      const result = extract(`export const config = { systemPrompt: 'You are a researcher' };\n`);
      expect(result!.systemPrompt).toBe('You are a researcher');
    });

    it('提取 model（字符串）', () => {
      const result = extract(`export const config = { model: 'gpt-4' };\n`);
      expect(result!.model).toBe('gpt-4');
    });

    it('提取 maxTurns（数字）', () => {
      const result = extract(`export const config = { maxTurns: 10 };\n`);
      expect(result!.maxTurns).toBe(10);
    });

    it('提取 tools（字符串数组）', () => {
      const result = extract(
        `export const config = { tools: ['weather.getWeather', 'web-search.search'] };\n`,
      );
      expect(result!.tools).toEqual(['weather.getWeather', 'web-search.search']);
    });

    it('提取 agents（字符串数组）', () => {
      const result = extract(`export const config = { agents: ['coder', 'writer'] };\n`);
      expect(result!.agents).toEqual(['coder', 'writer']);
    });

    it('提取全部 config 字段', () => {
      const result = extract(
        `export const config = {
          systemPrompt: 'You are a researcher',
          tools: ['weather.getWeather'],
          agents: ['coder'],
          model: 'gpt-4',
          maxTurns: 15,
        };\n`,
      );
      expect(result!.systemPrompt).toBe('You are a researcher');
      expect(result!.tools).toEqual(['weather.getWeather']);
      expect(result!.agents).toEqual(['coder']);
      expect(result!.model).toBe('gpt-4');
      expect(result!.maxTurns).toBe(15);
    });

    it('空 config 对象 → 所有字段 undefined', () => {
      const result = extract(`export const config = {};\n`);
      expect(result!.systemPrompt).toBeUndefined();
      expect(result!.tools).toBeUndefined();
      expect(result!.agents).toBeUndefined();
      expect(result!.model).toBeUndefined();
      expect(result!.maxTurns).toBeUndefined();
    });

    it('部分 config 字段缺失 → 对应字段 undefined', () => {
      const result = extract(`export const config = { systemPrompt: 'x', model: 'gpt-4' };\n`);
      expect(result!.systemPrompt).toBe('x');
      expect(result!.model).toBe('gpt-4');
      expect(result!.tools).toBeUndefined();
      expect(result!.agents).toBeUndefined();
      expect(result!.maxTurns).toBeUndefined();
    });
  });

  describe('config 块字段提取（函数返回对象）', () => {
    it('从 export function config() 的 return 提取字段', () => {
      const result = extract(
        `export function config() {
          return { systemPrompt: 'x', model: 'gpt-4', maxTurns: 5 };
        }\n`,
      );
      expect(result!.systemPrompt).toBe('x');
      expect(result!.model).toBe('gpt-4');
      expect(result!.maxTurns).toBe(5);
    });

    it('函数 config 无 return 语句 → 字段 undefined', () => {
      const result = extract(`export function config() { console.log('x'); }\n`);
      expect(result!.systemPrompt).toBeUndefined();
    });

    it('函数 config return 非对象字面量 → 字段 undefined', () => {
      const result = extract(`export function config() { return someVar; }\n`);
      expect(result!.systemPrompt).toBeUndefined();
    });
  });

  describe('非字面量值处理', () => {
    it('变量引用的 systemPrompt → undefined', () => {
      const result = extract(
        `const prompt = 'x';\nexport const config = { systemPrompt: prompt };\n`,
      );
      expect(result!.systemPrompt).toBeUndefined();
    });

    it('模板字符串的 systemPrompt → undefined', () => {
      const result = extract(`export const config = { systemPrompt: \`hello\` };\n`);
      expect(result!.systemPrompt).toBeUndefined();
    });

    it('混合元素的 tools → undefined（数组含非 StringLiteral）', () => {
      const result = extract(
        `const extra = 'x';\nexport const config = { tools: ['a', extra] };\n`,
      );
      expect(result!.tools).toBeUndefined();
    });

    it('空数组 tools → 空数组', () => {
      const result = extract(`export const config = { tools: [] };\n`);
      expect(result!.tools).toEqual([]);
    });

    it('非数字的 maxTurns → undefined', () => {
      const result = extract(`export const config = { maxTurns: '10' };\n`);
      expect(result!.maxTurns).toBeUndefined();
    });

    it('Spread 元素 → 跳过该属性', () => {
      const result = extract(`export const config = { ...other, systemPrompt: 'x' };\n`);
      expect(result!.systemPrompt).toBe('x');
    });
  });

  describe('透传字段', () => {
    it('filePath / hasRun 从 pathMeta 透传', () => {
      const result = extract(`export const config = {};\n`, {
        name: 'researcher',
        filePath: 'src/agents/researcher/handler.ts',
        hasRun: false,
      });
      expect(result!.filePath).toBe('src/agents/researcher/handler.ts');
      expect(result!.hasRun).toBe(false);
    });
  });

  describe('边界情况', () => {
    it('源文件不在 Program 中 → null', () => {
      const program = createProgram(tempFile);
      // 不写文件，直接调用
      const result = extractAgentMetadata(program, '/nonexistent/handler.ts', meta);
      expect(result).toBeNull();
    });

    it('无 config 导出 → 仅返回 pathMeta + JSDoc', () => {
      const result = extract(`/** 自定义 */\nexport function run(input) { return 'ok'; }\n`, {
        ...meta,
        hasRun: true,
      });
      expect(result).not.toBeNull();
      expect(result!.hasRun).toBe(true);
      expect(result!.description).toBe('自定义');
      expect(result!.systemPrompt).toBeUndefined();
      expect(result!.model).toBeUndefined();
    });

    it('config 用字符串键名', () => {
      const result = extract(`export const config = { 'systemPrompt': 'x', 'model': 'gpt-4' };\n`);
      expect(result!.systemPrompt).toBe('x');
      expect(result!.model).toBe('gpt-4');
    });
  });
});
