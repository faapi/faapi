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

    it('提取带 @see 标签的 JSDoc 首段描述', () => {
      const result = extract(
        `/**\n * 研究员\n * @see researcher\n */\nexport const config = { systemPrompt: 'x' };\n`,
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
        `/** @see researcher */\nexport const config = { systemPrompt: 'x' };\n`,
      );
      expect(result).not.toBeNull();
      expect(result!.description).toBeUndefined();
    });

    it('无 JSDoc 时 description 为 undefined', () => {
      const result = extract(
        `export const config = { systemPrompt: 'x' };\nexport function helper() { return 'ok'; }\n`,
      );
      expect(result).not.toBeNull();
      expect(result!.description).toBeUndefined();
    });
  });

  describe('@agent 覆盖名已移除 → 迁移错误', () => {
    it('@agent 标签有值 → 抛迁移错误（agent 名由目录路径推导）', () => {
      expect(() =>
        extract(`/** @agent super-researcher */\nexport const config = { systemPrompt: 'x' };\n`),
      ).toThrow(/已移除/);
    });

    it('描述 + @agent 标签共存同样抛迁移错误（与描述提取无关）', () => {
      expect(() =>
        extract(
          `/**\n * 研究员\n * @agent super-researcher\n */\nexport const config = { systemPrompt: 'x' };\n`,
        ),
      ).toThrow(/已移除/);
    });

    it('花括号包裹的 @agent 标签值同样抛迁移错误', () => {
      expect(() =>
        extract(`/** @agent {super-researcher} */\nexport const config = { systemPrompt: 'x' };\n`),
      ).toThrow(/已移除/);
    });

    it('迁移错误含改名目录指引', () => {
      try {
        extract(`/** @agent super-researcher */\nexport const config = { systemPrompt: 'x' };\n`);
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(SchemaExtractionError);
        expect((err as Error).message).toContain('删除 @agent JSDoc 标签');
        expect((err as Error).message).toContain('改名目录');
      }
    });

    it('无 @agent 标签时 name 为目录推导值', () => {
      const result = extract(`/** 研究员 */\nexport const config = { systemPrompt: 'x' };\n`);
      expect(result).not.toBeNull();
      expect(result!.name).toBe('researcher');
    });

    it('@agent 标签无值（裸标签）不构成残留，维持回退语义不报错', () => {
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

    it('提取 tools（无插值模板字符串元素）', () => {
      const result = extract(
        'export const config = { systemPrompt: `x`, tools: [`weather_getWeather`, `y`] };\n',
      );
      expect(result!.tools).toEqual(['weather_getWeather', 'y']);
    });

    it('空数组 tools → 空数组', () => {
      const result = extract(`export const config = { systemPrompt: 'x', tools: [] };\n`);
      expect(result!.tools).toEqual([]);
    });

    it('提取 maxTurns（数字）', () => {
      const result = extract(`export const config = { systemPrompt: 'x', maxTurns: 10 };\n`);
      expect(result!.maxTurns).toBe(10);
    });

    it('提取 inputDescription（字符串）', () => {
      const result = extract(
        `export const config = { systemPrompt: 'x', inputDescription: '章节拆解交接单,含章节原文' };\n`,
      );
      expect(result!.inputDescription).toBe('章节拆解交接单,含章节原文');
    });

    it('inputDescription 未声明 → undefined', () => {
      const result = extract(`export const config = { systemPrompt: 'x', maxTurns: 3 };\n`);
      expect(result!.inputDescription).toBeUndefined();
    });

    it('inputDescription 非字符串值 → 抛错', () => {
      expect(() =>
        extract(`export const config = { systemPrompt: 'x', inputDescription: 42 };\n`),
      ).toThrow(SchemaExtractionError);
    });

    it('提取 tools（字符串数组）', () => {
      const result = extract(
        `export const config = { systemPrompt: 'x', tools: ['weather_getWeather', 'web-search_search'] };\n`,
      );
      expect(result!.tools).toEqual(['weather_getWeather', 'web-search_search']);
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
          tools: ['weather_getWeather'],
          agents: ['coder'],
          maxTurns: 15,
        };\n`,
      );
      expect(result!.systemPrompt).toBe('You are a researcher');
      expect(result!.tools).toEqual(['weather_getWeather']);
      expect(result!.agents).toEqual(['coder']);
      expect(result!.maxTurns).toBe(15);
    });

    it('部分 config 字段缺失 → 对应字段 undefined', () => {
      const result = extract(`export const config = { systemPrompt: 'x', maxTurns: 3 };\n`);
      expect(result!.systemPrompt).toBe('x');
      expect(result!.maxTurns).toBe(3);
      expect(result!.tools).toBeUndefined();
      expect(result!.agents).toBeUndefined();
      expect(result!.inputDescription).toBeUndefined();
    });
  });

  describe('config.vars 提取（提示词模板变量）', () => {
    it('提取混合类型 vars（string/number/boolean）', () => {
      const result = extract(
        `export const config = { systemPrompt: 'x', vars: { role: '情节审稿', maxTurnsHint: 8, strict: true } };\n`,
      );
      expect(result!.vars).toEqual({ role: '情节审稿', maxTurnsHint: 8, strict: true });
    });

    it('vars 未声明 → undefined', () => {
      const result = extract(`export const config = { systemPrompt: 'x', maxTurns: 3 };\n`);
      expect(result!.vars).toBeUndefined();
    });

    it('vars 空对象 → 空对象（声明即渲染）', () => {
      const result = extract(`export const config = { systemPrompt: 'x', vars: {} };\n`);
      expect(result!.vars).toEqual({});
    });

    it('vars 叶子支持无插值模板字符串与 + 拼接（与 systemPrompt 同规则）', () => {
      const result = extract(
        "export const config = { systemPrompt: 'x', vars: { a: `模板`, b: '审' + '稿' } };\n",
      );
      expect(result!.vars).toEqual({ a: '模板', b: '审稿' });
    });

    it('vars 非对象值（字符串/数字）→ 抛错', () => {
      expect(() => extract(`export const config = { systemPrompt: 'x', vars: 'role' };\n`)).toThrow(
        SchemaExtractionError,
      );
      expect(() => extract(`export const config = { systemPrompt: 'x', vars: 3 };\n`)).toThrow(
        SchemaExtractionError,
      );
    });

    it('vars 嵌套对象叶子 → 抛错（仅平面一层）', () => {
      expect(() =>
        extract(`export const config = { systemPrompt: 'x', vars: { item: { title: 'x' } } };\n`),
      ).toThrow(SchemaExtractionError);
    });

    it('vars 数组叶子 → 抛错', () => {
      expect(() =>
        extract(`export const config = { systemPrompt: 'x', vars: { list: ['a'] } };\n`),
      ).toThrow(SchemaExtractionError);
    });

    it('vars 标识符引用叶子（shorthand）→ 抛错', () => {
      expect(() =>
        extract(
          `const role = 'x';\nexport const config = { systemPrompt: 'x', vars: { role } };\n`,
        ),
      ).toThrow(SchemaExtractionError);
    });

    it('vars 显式标识符引用叶子 → 抛错', () => {
      expect(() =>
        extract(
          `const role = 'x';\nexport const config = { systemPrompt: 'x', vars: { role: role } };\n`,
        ),
      ).toThrow(SchemaExtractionError);
    });

    it('vars 含插值模板字符串叶子 → 抛错', () => {
      expect(() =>
        extract(`export const config = { systemPrompt: 'x', vars: { a: \`前\${'x'}后\` } };\n`),
      ).toThrow(SchemaExtractionError);
    });

    it('vars null / undefined 字面量叶子 → 抛错', () => {
      expect(() =>
        extract(`export const config = { systemPrompt: 'x', vars: { a: null } };\n`),
      ).toThrow(SchemaExtractionError);
      expect(() =>
        extract(`export const config = { systemPrompt: 'x', vars: { a: undefined } };\n`),
      ).toThrow(SchemaExtractionError);
    });
  });

  describe('config 块字段提取（函数返回对象）', () => {
    it('从 export function config() 的 return 提取字段', () => {
      const result = extract(
        `export function config() {
          return { systemPrompt: 'x', maxTurns: 5 };
        }\n`,
      );
      expect(result!.systemPrompt).toBe('x');
      expect(result!.maxTurns).toBe(5);
    });
  });

  describe('systemPrompt 必填 → 缺失抛 SchemaExtractionError', () => {
    it('无 config 导出 → 抛必填错', () => {
      expect(() =>
        extract(`/** 自定义 */\nexport function helper(input) { return 'ok'; }\n`),
      ).toThrow(SchemaExtractionError);
    });

    it('config 空对象 → 抛错', () => {
      expect(() => extract(`export const config = {};\n`)).toThrow(SchemaExtractionError);
    });

    it('config 无 systemPrompt 字段（有其他字段）→ 抛错', () => {
      expect(() => extract(`export const config = { maxTurns: 5 };\n`)).toThrow(
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
        extract(`/** 自定义 */\nexport const config = { maxTurns: 3 };\n`);
        expect.unreachable();
      } catch (err) {
        expect((err as SchemaExtractionError).location?.file).toBe(tempFile);
        expect((err as SchemaExtractionError).location?.line).toBe(2);
      }
    });
  });

  describe('systemPromptFile（相对 resources 的提示词文件）', () => {
    it('提取路径字面量，systemPrompt 为 undefined', () => {
      const result = extract(
        `export const config = { systemPromptFile: 'prompts/research.md' };\n`,
      );
      expect(result).not.toBeNull();
      expect(result!.systemPromptFile).toBe('prompts/research.md');
      expect(result!.systemPrompt).toBeUndefined();
    });

    it('只声明 systemPromptFile 通过二选一必填校验（无内联 systemPrompt）', () => {
      const result = extract(`export const config = { systemPromptFile: 'p.md', maxTurns: 3 };\n`);
      expect(result).not.toBeNull();
      expect(result!.maxTurns).toBe(3);
    });

    it('模板字符串与 + 拼接同样提取（与 systemPrompt 同源求值）', () => {
      const result = extract("export const config = { systemPromptFile: 'prompts/' + 'a.md' };\n");
      expect(result!.systemPromptFile).toBe('prompts/a.md');
    });

    it('systemPrompt 与 systemPromptFile 同时声明 → 互斥抛错', () => {
      expect(() =>
        extract(`export const config = { systemPrompt: 'x', systemPromptFile: 'p.md' };\n`),
      ).toThrow(/互斥/);
    });

    it('systemPromptFile 非字面量（变量引用）→ 抛 SchemaExtractionError', () => {
      expect(() =>
        extract(`const p = 'p.md';\nexport const config = { systemPromptFile: p };\n`),
      ).toThrow(SchemaExtractionError);
    });
  });

  describe('config.model 已移除 → 迁移报错', () => {
    it('字符串字面量 model → 抛迁移错误含指引', () => {
      expect(() =>
        extract(`export const config = { systemPrompt: 'x', model: 'gpt-4' };\n`),
      ).toThrow(/config\.model 已移除/);
    });

    it('字符串属性名 model（"model"）同样命中迁移错误', () => {
      expect(() =>
        extract(`export const config = { systemPrompt: 'x', 'model': 'gpt-4' };\n`),
      ).toThrow(/config\.model 已移除/);
    });

    it('变量引用 / 拼接等任意值形式都是迁移错误（不再有提取失败语义）', () => {
      expect(() =>
        extract(`const m = 'gpt-4';\nexport const config = { systemPrompt: 'x', model: m };\n`),
      ).toThrow(/config\.model 已移除/);
      expect(() =>
        extract(`export const config = { systemPrompt: 'x', model: 'gpt' + '-4' };\n`),
      ).toThrow(/config\.model 已移除/);
    });

    it('迁移错误定位到 model 属性所在 file:line:column', () => {
      try {
        extract("export const config = {\n  systemPrompt: 'x',\n  model: 'gpt-4',\n};\n");
        expect.unreachable();
      } catch (err) {
        expect((err as SchemaExtractionError).location?.file).toBe(tempFile);
        expect((err as SchemaExtractionError).location?.line).toBe(3);
      }
    });
  });

  describe('run 导出检测 → 迁移报错（自定义 run 已移除）', () => {
    it('export async function run → 抛 SchemaExtractionError 含迁移指引', () => {
      expect(() => extract(`export async function run(args, ctx) { return args; }\n`)).toThrow(
        /run 已移除/,
      );
    });

    it('export const run 箭头函数同样报错', () => {
      expect(() => extract(`export const run = async (args) => args;\n`)).toThrow(/run 已移除/);
    });

    it('config + run 同时声明 → 仍报 run 迁移错（run 优先检测）', () => {
      expect(() =>
        extract(
          `export const config = { systemPrompt: 'x' };\nexport async function run(args) { return args; }\n`,
        ),
      ).toThrow(/run 已移除/);
    });

    it('非导出的局部 run 函数不误伤', () => {
      const result = extract(
        `function run(input) { return input; }\nexport const config = { systemPrompt: 'x' };\n`,
      );
      expect(result).not.toBeNull();
      expect(result!.systemPrompt).toBe('x');
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
        extract("const k = 'maxTurn';\nexport const config = { systemPrompt: 'x', [k]: 3 };\n"),
      ).toThrow(/computed/);
    });

    it('shorthand 属性 → 抛错', () => {
      expect(() =>
        extract(`const systemPrompt = 'x';\nexport const config = { systemPrompt };\n`),
      ).toThrow(/仅支持 key: value/);
    });

    it('方法形式属性 → 抛错', () => {
      expect(() =>
        extract(`export const config = { systemPrompt: 'x', maxTurns() { return 3; } };\n`),
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

  describe('字符串拼接静态求值（字面量 + 拼接）', () => {
    it('两段字符串字面量拼接 → 求值合并', () => {
      const result = extract(
        `export const config = { systemPrompt: 'You are' + ' a researcher' };\n`,
      );
      expect(result!.systemPrompt).toBe('You are a researcher');
    });

    it('多段链式拼接（多行写法）→ 全部合并', () => {
      const result = extract(
        `export const config = {
          systemPrompt: 'You are a researcher.' +
            ' Search the web.' +
            ' Summarize findings.',
        };\n`,
      );
      expect(result!.systemPrompt).toBe(
        'You are a researcher. Search the web. Summarize findings.',
      );
    });

    it('字面量与无插值模板字符串混合拼接 → 求值合并', () => {
      const result = extract("export const config = { systemPrompt: `line1\n` + 'line2' };\n");
      expect(result!.systemPrompt).toBe('line1\nline2');
    });

    it('tools 数组元素支持字面量拼接', () => {
      const result = extract(
        `export const config = { systemPrompt: 'x', tools: ['weather' + '_getWeather', 'search'] };\n`,
      );
      expect(result!.tools).toEqual(['weather_getWeather', 'search']);
    });

    it('拼接含变量引用 → 抛错', () => {
      expect(() =>
        extract(`const part = 'x';\nexport const config = { systemPrompt: 'a' + part };\n`),
      ).toThrow(SchemaExtractionError);
    });

    it('拼接含插值模板字符串 → 抛错', () => {
      expect(() =>
        extract("const n = 'x';\nexport const config = { systemPrompt: 'a' + `b${n}` };\n"),
      ).toThrow(SchemaExtractionError);
    });

    it('拼接混入数字字面量 → 抛错（仅字符串拼接）', () => {
      expect(() => extract(`export const config = { systemPrompt: 'a' + 1 };\n`)).toThrow(
        SchemaExtractionError,
      );
    });

    it('非加号运算符 → 抛错', () => {
      expect(() => extract(`export const config = { systemPrompt: 'a' - 'b' };\n`)).toThrow(
        SchemaExtractionError,
      );
    });

    it('数组元素拼接混入变量 → 抛错', () => {
      expect(() =>
        extract(`const t = 'a';\nexport const config = { systemPrompt: 'x', tools: ['b' + t] };\n`),
      ).toThrow(SchemaExtractionError);
    });

    it('抛错信息说明支持拼接', () => {
      try {
        extract(`export const config = { systemPrompt: 'a' + 1 };\n`);
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(SchemaExtractionError);
        expect((err as Error).message).toContain('config.systemPrompt');
        expect((err as Error).message).toContain('拼接');
        expect((err as Error).message).toContain('模板字符串');
      }
    });
  });

  describe('透传字段', () => {
    it('filePath 从 pathMeta 透传', () => {
      const result = extract(`export const config = { systemPrompt: 'x' };\n`, {
        name: 'researcher',
        filePath: 'src/agents/researcher/handler.ts',
      });
      expect(result!.filePath).toBe('src/agents/researcher/handler.ts');
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
      const result = extract(`export const config = { 'systemPrompt': 'x', 'maxTurns': 5 };\n`);
      expect(result!.systemPrompt).toBe('x');
      expect(result!.maxTurns).toBe(5);
    });
  });

  describe('派发入参 schema 声明（Input 导出检测）', () => {
    it('顶层 interface Input → inputTypeName 为 "Input"', () => {
      const result = extract(
        `export const config = { systemPrompt: 'x' };\n` +
          `export interface Input {\n  novelId: string;\n  chapterId: number;\n}\n`,
      );
      expect(result!.inputTypeName).toBe('Input');
    });

    it('顶层 type Input = {...} → inputTypeName 为 "Input"', () => {
      const result = extract(
        `export const config = { systemPrompt: 'x' };\n` +
          `export type Input = { novelId: string };\n`,
      );
      expect(result!.inputTypeName).toBe('Input');
    });

    it('未声明 Input → inputTypeName 为 undefined（向后兼容）', () => {
      const result = extract(`export const config = { systemPrompt: 'x' };\n`);
      expect(result!.inputTypeName).toBeUndefined();
    });

    it('其他名字的类型导出（如 Payload）不构成声明', () => {
      const result = extract(
        `export const config = { systemPrompt: 'x' };\n` +
          `export interface Payload { novelId: string }\n`,
      );
      expect(result!.inputTypeName).toBeUndefined();
    });

    it('同名非类型导出（const Input）不构成声明', () => {
      const result = extract(
        `export const config = { systemPrompt: 'x' };\n` +
          `export const Input = { novelId: 'x' };\n`,
      );
      expect(result!.inputTypeName).toBeUndefined();
    });

    it('未导出的 interface Input 也检测（AST 按名字定位,导出与否不限）', () => {
      const result = extract(
        `export const config = { systemPrompt: 'x' };\n` +
          `interface Input {\n  novelId: string;\n}\n`,
      );
      expect(result!.inputTypeName).toBe('Input');
    });

    it('import 进来的同名类型无本地声明 → 不构成声明', () => {
      const result = extract(
        `import type { Input } from './types';\n` +
          `export const config = { systemPrompt: 'x' };\n`,
      );
      expect(result!.inputTypeName).toBeUndefined();
    });

    it('Input 检测不影响其他字段提取', () => {
      const result = extract(
        `/** 研究员 */\n` +
          `export const config = { systemPrompt: 'x', maxTurns: 5, inputDescription: '交接单' };\n` +
          `export interface Input { q: string }\n`,
      );
      expect(result!.description).toBe('研究员');
      expect(result!.systemPrompt).toBe('x');
      expect(result!.maxTurns).toBe(5);
      expect(result!.inputDescription).toBe('交接单');
      expect(result!.inputTypeName).toBe('Input');
    });
  });
});
