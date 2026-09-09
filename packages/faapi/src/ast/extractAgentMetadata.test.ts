import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProgram, invalidateProgramCache } from './createProgram';
import { extractAgentMetadata, type AgentPathMeta } from './extractAgentMetadata';
import { SchemaExtractionError } from './resolveTypeNode';

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
    // 清空模块级 Program 缓存，避免随测试数累积耗尽 worker 堆内存（OOM）
    invalidateProgramCache();
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
        `/**\n * 研究员 agent\n * 负责搜索和总结\n */\nexport const config = { systemPrompt: 'x' };\n`,
      );
      expect(result).not.toBeNull();
      expect(result!.description).toBe('研究员 agent\n负责搜索和总结');
    });

    it('提取带 @agent 标签的 JSDoc 首段描述', () => {
      const result = extract(
        `/**\n * 研究员\n * @agent researcher\n */\nexport const config = { systemPrompt: 'x' };\n`,
      );
      expect(result).not.toBeNull();
      expect(result!.description).toBe('研究员');
    });

    it('无 JSDoc 时 description 为 undefined', () => {
      const result = extract(`export const config = { systemPrompt: 'x' };\n`);
      expect(result).not.toBeNull();
      expect(result!.description).toBeUndefined();
    });

    it('JSDoc 只有标签无自由文本时 description 为 undefined', () => {
      const result = extract(
        `/** @agent researcher */\nexport const config = { systemPrompt: 'x' };\n`,
      );
      expect(result).not.toBeNull();
      expect(result!.description).toBeUndefined();
    });

    it('config 和 run 都无 JSDoc 时 description 为 undefined', () => {
      const result = extract(
        `export const config = { systemPrompt: 'x' };\nexport function run() { return 'ok'; }\n`,
        { ...meta, hasRun: true },
      );
      expect(result).not.toBeNull();
      expect(result!.description).toBeUndefined();
    });
  });

  describe('@agent 覆盖名', () => {
    it('提取 @agent 标签覆盖名', () => {
      const result = extract(
        `/** @agent super-researcher */\nexport const config = { systemPrompt: 'x' };\n`,
      );
      expect(result).not.toBeNull();
      expect(result!.name).toBe('super-researcher');
    });

    it('提取带花括号的 @agent 标签值', () => {
      const result = extract(
        `/** @agent {super-researcher} */\nexport const config = { systemPrompt: 'x' };\n`,
      );
      expect(result).not.toBeNull();
      expect(result!.name).toBe('super-researcher');
    });

    it('描述 + @agent 标签共存', () => {
      const result = extract(
        `/**\n * 研究员\n * @agent super-researcher\n */\nexport const config = { systemPrompt: 'x' };\n`,
      );
      expect(result).not.toBeNull();
      expect(result!.name).toBe('super-researcher');
      expect(result!.description).toBe('研究员');
    });

    it('无 @agent 标签时回退到 pathMeta.name', () => {
      const result = extract(`/** 研究员 */\nexport const config = { systemPrompt: 'x' };\n`);
      expect(result).not.toBeNull();
      expect(result!.name).toBe('researcher');
    });

    it('@agent 标签无值时回退到 pathMeta.name', () => {
      const result = extract(`/** @agent */\nexport const config = { systemPrompt: 'x' };\n`);
      expect(result).not.toBeNull();
      expect(result!.name).toBe('researcher');
    });
  });

  describe('config 块字段提取（对象字面量）', () => {
    it('提取 systemPrompt（字符串）', () => {
      const result = extract(`export const config = { systemPrompt: 'You are a researcher' };\n`);
      expect(result!.systemPrompt).toBe('You are a researcher');
    });

    it('提取 systemPrompt（无插值模板字符串，语义等价字符串字面量）', () => {
      const result = extract('export const config = { systemPrompt: `You are a researcher` };\n');
      expect(result!.systemPrompt).toBe('You are a researcher');
    });

    it('提取多行无插值模板字符串的 systemPrompt（保留换行）', () => {
      const result = extract(
        'export const config = { systemPrompt: `You are a log analyzer.\nAnalyze logs carefully.` };\n',
      );
      expect(result!.systemPrompt).toBe('You are a log analyzer.\nAnalyze logs carefully.');
    });

    it('提取 model（无插值模板字符串）', () => {
      const result = extract('export const config = { systemPrompt: `x`, model: `gpt-4` };\n');
      expect(result!.model).toBe('gpt-4');
    });

    it('提取 tools（无插值模板字符串元素）', () => {
      const result = extract(
        'export const config = { systemPrompt: `x`, tools: [`weather.getWeather`, `y`] };\n',
      );
      expect(result!.tools).toEqual(['weather.getWeather', 'y']);
    });

    it('空数组 tools → 空数组', () => {
      const result = extract(`export const config = { systemPrompt: 'x', tools: [] };\n`);
      expect(result!.tools).toEqual([]);
    });

    it('提取 model（字符串）', () => {
      const result = extract(`export const config = { systemPrompt: 'x', model: 'gpt-4' };\n`);
      expect(result!.model).toBe('gpt-4');
    });

    it('提取 maxTurns（数字）', () => {
      const result = extract(`export const config = { systemPrompt: 'x', maxTurns: 10 };\n`);
      expect(result!.maxTurns).toBe(10);
    });

    it('提取 tools（字符串数组）', () => {
      const result = extract(
        `export const config = { systemPrompt: 'x', tools: ['weather.getWeather', 'web-search.search'] };\n`,
      );
      expect(result!.tools).toEqual(['weather.getWeather', 'web-search.search']);
    });

    it('提取 agents（字符串数组）', () => {
      const result = extract(
        `export const config = { systemPrompt: 'x', agents: ['coder', 'writer'] };\n`,
      );
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
  });

  describe('systemPrompt 必填 → 缺失抛 SchemaExtractionError', () => {
    it('无 config 导出（仅 run）→ 抛错', () => {
      expect(() =>
        extract(`/** 自定义 */\nexport function run(input) { return 'ok'; }\n`, {
          ...meta,
          hasRun: true,
        }),
      ).toThrow(SchemaExtractionError);
    });

    it('config 空对象 → 抛错', () => {
      expect(() => extract(`export const config = {};\n`)).toThrow(SchemaExtractionError);
    });

    it('config 无 systemPrompt 字段（有其他字段）→ 抛错', () => {
      expect(() => extract(`export const config = { model: 'gpt-4', maxTurns: 5 };\n`)).toThrow(
        SchemaExtractionError,
      );
    });

    it('函数 config 无 return 语句 → 抛错', () => {
      expect(() => extract(`export function config() { console.log('x'); }\n`)).toThrow(
        SchemaExtractionError,
      );
    });

    it('函数 config return 非对象字面量 → 抛错', () => {
      expect(() => extract(`export function config() { return someVar; }\n`)).toThrow(
        SchemaExtractionError,
      );
    });

    it('Spread 未提供 systemPrompt → 抛错', () => {
      expect(() => extract(`export const config = { ...other };\n`)).toThrow(SchemaExtractionError);
    });

    it('抛错信息含 systemPrompt 必填提示', () => {
      try {
        extract(`export const config = {};\n`);
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(SchemaExtractionError);
        expect((err as Error).message).toContain('systemPrompt');
        expect((err as Error).message).toContain('必填');
      }
    });

    it('抛错定位到 config 块 file:line:column', () => {
      try {
        extract(`/** 自定义 */\nexport const config = { model: 'gpt-4' };\n`);
        expect.unreachable();
      } catch (err) {
        expect((err as SchemaExtractionError).location?.file).toBe(tempFile);
        expect((err as SchemaExtractionError).location?.line).toBe(2);
      }
    });
  });

  describe('config 形式与字段声明不如预期 → 抛 SchemaExtractionError', () => {
    it('config 声明为变量引用（非对象字面量）→ 抛错', () => {
      expect(() =>
        extract(`const base = { systemPrompt: 'x' };\nexport const config = base;\n`),
      ).toThrow(/仅支持/);
    });

    it('箭头函数返回非对象字面量 → 抛错', () => {
      expect(() => extract(`export const config = () => 'str';\n`)).toThrow(/仅支持/);
    });

    it('config 声明未知字段（拼写错误）→ 抛错', () => {
      expect(() => extract(`export const config = { systemPrompt: 'x', maxTurn: 3 };\n`)).toThrow(
        /未知 config 字段/,
      );
    });

    it('config 声明任意未知字段 → 抛错', () => {
      expect(() => extract(`export const config = { systemPrompt: 'x', foo: 1 };\n`)).toThrow(
        /未知 config 字段/,
      );
    });

    it('computed 属性名 → 抛错', () => {
      expect(() =>
        extract("const k = 'model';\nexport const config = { systemPrompt: 'x', [k]: 'gpt-4' };\n"),
      ).toThrow(/computed/);
    });

    it('shorthand 属性 → 抛错', () => {
      expect(() =>
        extract(`const systemPrompt = 'x';\nexport const config = { systemPrompt };\n`),
      ).toThrow(/仅支持 key: value/);
    });

    it('方法形式属性 → 抛错', () => {
      expect(() =>
        extract(`export const config = { systemPrompt: 'x', model() { return 'gpt-4'; } };\n`),
      ).toThrow(/仅支持 key: value/);
    });
  });

  describe('声明了字段但值提取失败 → 抛 SchemaExtractionError', () => {
    it('变量引用的 systemPrompt → 抛错', () => {
      expect(() =>
        extract(`const prompt = 'x';\nexport const config = { systemPrompt: prompt };\n`),
      ).toThrow(SchemaExtractionError);
    });

    it('含插值模板字符串的 systemPrompt → 抛错', () => {
      expect(() =>
        extract("const name = 'x';\nexport const config = { systemPrompt: `hello ${name}` };\n"),
      ).toThrow(SchemaExtractionError);
    });

    it('混合元素的 tools → 抛错（数组含非字符串字面量）', () => {
      expect(() =>
        extract(
          `const extra = 'x';\nexport const config = { systemPrompt: 'x', tools: ['a', extra] };\n`,
        ),
      ).toThrow(SchemaExtractionError);
    });

    it('非数组的 tools → 抛错', () => {
      expect(() => extract(`export const config = { systemPrompt: 'x', tools: 'a' };\n`)).toThrow(
        SchemaExtractionError,
      );
    });

    it('变量引用的 model → 抛错', () => {
      expect(() =>
        extract(`const m = 'gpt-4';\nexport const config = { systemPrompt: 'x', model: m };\n`),
      ).toThrow(SchemaExtractionError);
    });

    it('非数字的 maxTurns → 抛错', () => {
      expect(() =>
        extract(`export const config = { systemPrompt: 'x', maxTurns: '10' };\n`),
      ).toThrow(SchemaExtractionError);
    });

    it('抛错信息携带字段名与支持的写法提示', () => {
      try {
        extract(`export const config = { systemPrompt: someVar };\n`);
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(SchemaExtractionError);
        expect((err as Error).message).toContain('config.systemPrompt');
        expect((err as Error).message).toContain('模板字符串');
      }
    });

    it('抛错定位到字段所在 file:line:column', () => {
      try {
        extract('export const config = {\n  systemPrompt: v,\n};\n');
        expect.unreachable();
      } catch (err) {
        expect((err as SchemaExtractionError).location?.file).toBe(tempFile);
        expect((err as SchemaExtractionError).location?.line).toBe(2);
      }
    });

    it('Spread 元素 → 跳过该属性（不报错）', () => {
      const result = extract(`export const config = { ...other, systemPrompt: 'x' };\n`);
      expect(result!.systemPrompt).toBe('x');
    });
  });

  describe('透传字段', () => {
    it('filePath / hasRun 从 pathMeta 透传', () => {
      const result = extract(`export const config = { systemPrompt: 'x' };\n`, {
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

    it('config 用字符串键名', () => {
      const result = extract(`export const config = { 'systemPrompt': 'x', 'model': 'gpt-4' };\n`);
      expect(result!.systemPrompt).toBe('x');
      expect(result!.model).toBe('gpt-4');
    });
  });
});
