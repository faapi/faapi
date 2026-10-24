import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProgram, invalidateProgramCache } from './createProgram';
import { extractToolMetadata, type ToolPathMeta } from './extractToolMetadata';

describe('extractToolMetadata', () => {
  let tempDir: string;
  let tempFile: string;

  beforeEach(() => {
    tempDir = join(
      tmpdir(),
      `faapi-test-tool-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tempDir, { recursive: true });
    tempFile = join(tempDir, 'handler.ts');
  });

  afterEach(() => {
    // 清空模块级 Program 缓存，避免随测试数累积耗尽 worker 堆内存（OOM）
    invalidateProgramCache();
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** 共享 tool 的默认 pathMeta */
  const sharedMeta: ToolPathMeta = {
    name: 'weather_getWeather',
    filePath: 'src/tools/weather/handler.ts',
  };

  describe('JSDoc 提取', () => {
    it('提取单行 JSDoc 描述', () => {
      writeFileSync(
        tempFile,
        `/** 获取天气 */\nexport function getWeather(input: WeatherInput) { return "sunny"; }\n`,
      );
      const program = createProgram(tempFile);
      const result = extractToolMetadata(program, tempFile, 'getWeather', sharedMeta);
      expect(result).not.toBeNull();
      expect(result!.description).toBe('获取天气');
    });

    it('提取多行 JSDoc 描述(保留换行)', () => {
      writeFileSync(
        tempFile,
        `/**\n * 获取指定城市的天气\n * 支持国内/国外城市\n */\nexport function getWeather(input: WeatherInput) { return "sunny"; }\n`,
      );
      const program = createProgram(tempFile);
      const result = extractToolMetadata(program, tempFile, 'getWeather', sharedMeta);
      expect(result).not.toBeNull();
      expect(result!.description).toBe('获取指定城市的天气\n支持国内/国外城市');
    });

    it('提取带 @param 标签的 JSDoc 首段描述', () => {
      writeFileSync(
        tempFile,
        `/**\n * 获取天气\n * @param input 城市名\n * @returns 天气信息\n */\nexport function getWeather(input: WeatherInput) { return "sunny"; }\n`,
      );
      const program = createProgram(tempFile);
      const result = extractToolMetadata(program, tempFile, 'getWeather', sharedMeta);
      expect(result).not.toBeNull();
      expect(result!.description).toBe('获取天气');
    });

    it('无 JSDoc 时 description 为 undefined', () => {
      writeFileSync(
        tempFile,
        `export function getWeather(input: WeatherInput) { return "sunny"; }\n`,
      );
      const program = createProgram(tempFile);
      const result = extractToolMetadata(program, tempFile, 'getWeather', sharedMeta);
      expect(result).not.toBeNull();
      expect(result!.description).toBeUndefined();
    });

    it('JSDoc 只有标签无自由文本时 description 为 undefined', () => {
      writeFileSync(
        tempFile,
        `/** @see weather_current */\nexport function getWeather(input: WeatherInput) { return "sunny"; }\n`,
      );
      const program = createProgram(tempFile);
      const result = extractToolMetadata(program, tempFile, 'getWeather', sharedMeta);
      expect(result).not.toBeNull();
      expect(result!.description).toBeUndefined();
    });
  });

  describe('@tool 覆盖名已移除 → 迁移错误', () => {
    it('@tool 标签有值 → 抛迁移错误（tool 名由目录路径 + 函数名推导）', () => {
      writeFileSync(
        tempFile,
        `/** @tool weather_current */\nexport function getWeather(input: WeatherInput) { return "sunny"; }\n`,
      );
      const program = createProgram(tempFile);
      expect(() => extractToolMetadata(program, tempFile, 'getWeather', sharedMeta)).toThrow(
        /已移除/,
      );
    });

    it('描述 + @tool 标签共存同样抛迁移错误（与描述提取无关）', () => {
      writeFileSync(
        tempFile,
        `/**\n * 获取当前天气\n * @tool weather_current\n */\nexport function getWeather(input: WeatherInput) { return "sunny"; }\n`,
      );
      const program = createProgram(tempFile);
      expect(() => extractToolMetadata(program, tempFile, 'getWeather', sharedMeta)).toThrow(
        /已移除/,
      );
    });

    it('花括号包裹的 @tool 标签值同样抛迁移错误', () => {
      writeFileSync(
        tempFile,
        `/** @tool {weather_current} */\nexport function getWeather(input: WeatherInput) { return "sunny"; }\n`,
      );
      const program = createProgram(tempFile);
      expect(() => extractToolMetadata(program, tempFile, 'getWeather', sharedMeta)).toThrow(
        /已移除/,
      );
    });

    it('迁移错误含改名目录或函数指引', () => {
      writeFileSync(
        tempFile,
        `/** @tool weather_current */\nexport function getWeather(input: WeatherInput) { return "sunny"; }\n`,
      );
      const program = createProgram(tempFile);
      try {
        extractToolMetadata(program, tempFile, 'getWeather', sharedMeta);
        expect.unreachable();
      } catch (err) {
        expect((err as Error).message).toContain('删除 @tool JSDoc 标签');
        expect((err as Error).message).toContain('改名目录或函数');
      }
    });

    it('无 @tool 标签时 name 使用 pathMeta.name', () => {
      writeFileSync(
        tempFile,
        `/** 获取天气 */\nexport function getWeather(input: WeatherInput) { return "sunny"; }\n`,
      );
      const program = createProgram(tempFile);
      const result = extractToolMetadata(program, tempFile, 'getWeather', sharedMeta);
      expect(result).not.toBeNull();
      expect(result!.name).toBe('weather_getWeather');
    });

    it('@tool 标签无值（裸标签）不构成残留，维持回退语义不报错', () => {
      writeFileSync(
        tempFile,
        `/**\n * 获取天气\n * @tool\n */\nexport function getWeather(input: WeatherInput) { return "sunny"; }\n`,
      );
      const program = createProgram(tempFile);
      const result = extractToolMetadata(program, tempFile, 'getWeather', sharedMeta);
      expect(result).not.toBeNull();
      expect(result!.name).toBe('weather_getWeather');
      expect(result!.description).toBe('获取天气');
    });
  });

  describe('第一个参数 interface 名', () => {
    it('提取 TypeReference 参数类型名', () => {
      writeFileSync(
        tempFile,
        `export interface WeatherInput { city: string; }\nexport function getWeather(input: WeatherInput) { return "sunny"; }\n`,
      );
      const program = createProgram(tempFile);
      const result = extractToolMetadata(program, tempFile, 'getWeather', sharedMeta);
      expect(result).not.toBeNull();
      expect(result!.inputTypeName).toBe('WeatherInput');
    });

    it('提取 type 别名参数类型名', () => {
      writeFileSync(
        tempFile,
        `export type WeatherInput = { city: string };\nexport function getWeather(input: WeatherInput) { return "sunny"; }\n`,
      );
      const program = createProgram(tempFile);
      const result = extractToolMetadata(program, tempFile, 'getWeather', sharedMeta);
      expect(result).not.toBeNull();
      expect(result!.inputTypeName).toBe('WeatherInput');
    });

    it('内联类型字面量参数 → inputTypeName 为 undefined', () => {
      writeFileSync(
        tempFile,
        `export function getWeather(input: { city: string }) { return "sunny"; }\n`,
      );
      const program = createProgram(tempFile);
      const result = extractToolMetadata(program, tempFile, 'getWeather', sharedMeta);
      expect(result).not.toBeNull();
      expect(result!.inputTypeName).toBeUndefined();
    });

    it('无类型标注参数 → inputTypeName 为 undefined', () => {
      writeFileSync(tempFile, `export function getWeather(input) { return "sunny"; }\n`);
      const program = createProgram(tempFile);
      const result = extractToolMetadata(program, tempFile, 'getWeather', sharedMeta);
      expect(result).not.toBeNull();
      expect(result!.inputTypeName).toBeUndefined();
    });

    it('无参数函数 → inputTypeName 为 undefined', () => {
      writeFileSync(tempFile, `/** 列出所有城市 */\nexport function listCities() { return []; }\n`);
      const program = createProgram(tempFile);
      const result = extractToolMetadata(program, tempFile, 'listCities', {
        name: 'listCities',
        filePath: 'src/tools/handler.ts',
      });
      expect(result).not.toBeNull();
      expect(result!.inputTypeName).toBeUndefined();
      expect(result!.description).toBe('列出所有城市');
    });

    it('多参数时取第一个参数的类型名', () => {
      writeFileSync(
        tempFile,
        `export interface WeatherInput { city: string; }\nexport function getWeather(input: WeatherInput, count: number) { return "sunny"; }\n`,
      );
      const program = createProgram(tempFile);
      const result = extractToolMetadata(program, tempFile, 'getWeather', sharedMeta);
      expect(result).not.toBeNull();
      expect(result!.inputTypeName).toBe('WeatherInput');
    });

    it('可选参数也提取类型名', () => {
      writeFileSync(
        tempFile,
        `export interface WeatherInput { city: string; }\nexport function getWeather(input?: WeatherInput) { return "sunny"; }\n`,
      );
      const program = createProgram(tempFile);
      const result = extractToolMetadata(program, tempFile, 'getWeather', sharedMeta);
      expect(result).not.toBeNull();
      expect(result!.inputTypeName).toBe('WeatherInput');
    });
  });

  describe('第二个参数 ctx 校验类型名', () => {
    /** 模拟框架契约的本地声明——ctxTypeName 提取按类型名匹配，无需真实类型 */
    const AGENT_CTX_DECL = `interface AgentToolContext { tasks: unknown; log: unknown; signal: unknown }\n`;

    it('TypeReference 第二参 → ctxTypeName', () => {
      writeFileSync(
        tempFile,
        `export interface OrderCtx { currentUserId: number }\n${AGENT_CTX_DECL}\n` +
          `export function getOrder(input: { orderId: string }, ctx: OrderCtx) { return {}; }\n`,
      );
      const program = createProgram(tempFile);
      const result = extractToolMetadata(program, tempFile, 'getOrder', sharedMeta);
      expect(result).not.toBeNull();
      expect(result!.ctxTypeName).toBe('OrderCtx');
      expect(result!.inputTypeName).toBeUndefined();
    });

    it('交叉类型拆分：业务类型 & AgentToolContext → 提取业务侧类型名', () => {
      writeFileSync(
        tempFile,
        `export interface OrderCtx { currentUserId: number }\n${AGENT_CTX_DECL}\n` +
          `export function getOrder(input: { orderId: string }, ctx: OrderCtx & AgentToolContext) { return {}; }\n`,
      );
      const program = createProgram(tempFile);
      const result = extractToolMetadata(program, tempFile, 'getOrder', sharedMeta);
      expect(result).not.toBeNull();
      expect(result!.ctxTypeName).toBe('OrderCtx');
    });

    it('裸标注 AgentToolContext → undefined（只要框架字段，无业务校验类型，不生成 schema）', () => {
      writeFileSync(
        tempFile,
        `${AGENT_CTX_DECL}\n` +
          `export function ping(input: { echo: string }, ctx: AgentToolContext) { return ''; }\n`,
      );
      const program = createProgram(tempFile);
      const result = extractToolMetadata(program, tempFile, 'ping', sharedMeta);
      expect(result).not.toBeNull();
      expect(result!.ctxTypeName).toBeUndefined();
    });

    it('裸标注跨文件 import 的 AgentToolContext → undefined（按类型名匹配，不依赖本地声明）', () => {
      writeFileSync(
        join(tempDir, 'framework.d.ts'),
        `export interface AgentToolContext {\n  tasks: unknown;\n  log: unknown;\n  signal: unknown;\n}\n`,
      );
      writeFileSync(
        tempFile,
        `import type { AgentToolContext } from '../../framework.js';\n` +
          `export function ping(input: { echo: string }, ctx: AgentToolContext) { return ''; }\n`,
      );
      const program = createProgram(tempFile);
      const result = extractToolMetadata(program, tempFile, 'ping', sharedMeta);
      expect(result).not.toBeNull();
      expect(result!.ctxTypeName).toBeUndefined();
    });

    it('交叉类型业务侧为内联字面量 → undefined（对齐 input 内联语义）', () => {
      writeFileSync(
        tempFile,
        `${AGENT_CTX_DECL}\n` +
          `export function getOrder(input: { orderId: string }, ctx: { currentUserId: number } & AgentToolContext) { return {}; }\n`,
      );
      const program = createProgram(tempFile);
      const result = extractToolMetadata(program, tempFile, 'getOrder', sharedMeta);
      expect(result).not.toBeNull();
      expect(result!.ctxTypeName).toBeUndefined();
    });

    it('交叉类型含多个业务成员 → 构建期抛 SchemaExtractionError（校验类型无法唯一确定）', () => {
      writeFileSync(
        tempFile,
        `export interface A { a: number }\nexport interface B { b: number }\n${AGENT_CTX_DECL}\n` +
          `export function getOrder(input: { orderId: string }, ctx: A & B & AgentToolContext) { return {}; }\n`,
      );
      const program = createProgram(tempFile);
      expect(() => extractToolMetadata(program, tempFile, 'getOrder', sharedMeta)).toThrow(
        /多个业务成员|校验类型/,
      );
    });

    it('无第二参 → ctxTypeName 为 undefined', () => {
      writeFileSync(tempFile, `export function listOrders() { return []; }\n`);
      const program = createProgram(tempFile);
      const result = extractToolMetadata(program, tempFile, 'listOrders', sharedMeta);
      expect(result).not.toBeNull();
      expect(result!.ctxTypeName).toBeUndefined();
    });

    it('第二参无类型标注 → ctxTypeName 为 undefined', () => {
      writeFileSync(
        tempFile,
        `export function listOrders(input: { a: number }, ctx) { return []; }\n`,
      );
      const program = createProgram(tempFile);
      const result = extractToolMetadata(program, tempFile, 'listOrders', sharedMeta);
      expect(result).not.toBeNull();
      expect(result!.ctxTypeName).toBeUndefined();
    });

    it('input 与 ctx 同时声明 → 两者都提取', () => {
      writeFileSync(
        tempFile,
        `export interface OrderInput { orderId: string }\nexport interface OrderCtx { currentUserId: number }\n${AGENT_CTX_DECL}\n` +
          `export function getOrder(input: OrderInput, ctx: OrderCtx & AgentToolContext) { return {}; }\n`,
      );
      const program = createProgram(tempFile);
      const result = extractToolMetadata(program, tempFile, 'getOrder', sharedMeta);
      expect(result).not.toBeNull();
      expect(result!.inputTypeName).toBe('OrderInput');
      expect(result!.ctxTypeName).toBe('OrderCtx');
    });
  });

  describe('导出形式', () => {
    it('export function', () => {
      writeFileSync(
        tempFile,
        `/** 描述 */\nexport function getWeather(input: WeatherInput) { return "sunny"; }\n`,
      );
      const program = createProgram(tempFile);
      const result = extractToolMetadata(program, tempFile, 'getWeather', sharedMeta);
      expect(result).not.toBeNull();
      expect(result!.description).toBe('描述');
    });

    it('export async function', () => {
      writeFileSync(
        tempFile,
        `/** 描述 */\nexport async function getWeather(input: WeatherInput) { return "sunny"; }\n`,
      );
      const program = createProgram(tempFile);
      const result = extractToolMetadata(program, tempFile, 'getWeather', sharedMeta);
      expect(result).not.toBeNull();
      expect(result!.description).toBe('描述');
    });

    it('export const = (箭头函数)', () => {
      writeFileSync(
        tempFile,
        `/** 描述 */\nexport const getWeather = (input: WeatherInput) => "sunny";\n`,
      );
      const program = createProgram(tempFile);
      const result = extractToolMetadata(program, tempFile, 'getWeather', sharedMeta);
      expect(result).not.toBeNull();
      expect(result!.description).toBe('描述');
      expect(result!.inputTypeName).toBe('WeatherInput');
    });

    it('export const = async (箭头函数)', () => {
      writeFileSync(
        tempFile,
        `/** 描述 */\nexport const getWeather = async (input: WeatherInput) => "sunny";\n`,
      );
      const program = createProgram(tempFile);
      const result = extractToolMetadata(program, tempFile, 'getWeather', sharedMeta);
      expect(result).not.toBeNull();
      expect(result!.description).toBe('描述');
      expect(result!.inputTypeName).toBe('WeatherInput');
    });

    it('export const = function 表达式', () => {
      writeFileSync(
        tempFile,
        `/** 描述 */\nexport const getWeather = function (input: WeatherInput) { return "sunny"; };\n`,
      );
      const program = createProgram(tempFile);
      const result = extractToolMetadata(program, tempFile, 'getWeather', sharedMeta);
      expect(result).not.toBeNull();
      expect(result!.description).toBe('描述');
      expect(result!.inputTypeName).toBe('WeatherInput');
    });

    it('箭头函数 name 与描述提取（JSDoc 在 export const 上方）', () => {
      writeFileSync(tempFile, `/** 当前时间 */\nexport const getNow = () => ({ now: 'fixed' });\n`);
      const program = createProgram(tempFile);
      const result = extractToolMetadata(program, tempFile, 'getNow', {
        name: 'getNow',
        filePath: 'src/tools/handler.ts',
      });
      expect(result).not.toBeNull();
      expect(result!.name).toBe('getNow');
      expect(result!.description).toBe('当前时间');
    });
  });

  describe('路径推导字段透传', () => {
    it('共享 tool: filePath/name 从 pathMeta 透传', () => {
      writeFileSync(tempFile, `export function getWeather() { return "sunny"; }\n`);
      const program = createProgram(tempFile);
      const result = extractToolMetadata(program, tempFile, 'getWeather', sharedMeta);
      expect(result).not.toBeNull();
      expect(result!.name).toBe('weather_getWeather');
      expect(result!.filePath).toBe('src/tools/weather/handler.ts');
      expect(result!.functionName).toBe('getWeather');
    });
  });

  describe('边界情况', () => {
    it('函数未找到时返回 null', () => {
      writeFileSync(tempFile, `export function otherFn() { return "ok"; }\n`);
      const program = createProgram(tempFile);
      const result = extractToolMetadata(program, tempFile, 'getWeather', sharedMeta);
      expect(result).toBeNull();
    });

    it('源文件不在 Program 中时返回 null', () => {
      const otherFile = join(tempDir, 'other.ts');
      writeFileSync(otherFile, `export function getWeather() { return "sunny"; }\n`);
      const program = createProgram(otherFile);
      // tempFile 不在 program 中
      const result = extractToolMetadata(program, tempFile, 'getWeather', sharedMeta);
      expect(result).toBeNull();
    });

    it('同文件多个函数,按 functionName 定位正确函数', () => {
      writeFileSync(
        tempFile,
        `export interface A { x: string }\nexport interface B { y: number }\n/** 函数 A 描述 */\nexport function fnA(input: A) { return "a"; }\n/** 函数 B 描述 */\nexport function fnB(input: B) { return "b"; }\n`,
      );
      const program = createProgram(tempFile);

      const aMeta: ToolPathMeta = {
        name: 'fnA',
        filePath: 'src/tools/handler.ts',
      };
      const bMeta: ToolPathMeta = {
        name: 'fnB',
        filePath: 'src/tools/handler.ts',
      };

      const a = extractToolMetadata(program, tempFile, 'fnA', aMeta);
      const b = extractToolMetadata(program, tempFile, 'fnB', bMeta);

      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
      expect(a!.description).toBe('函数 A 描述');
      expect(a!.inputTypeName).toBe('A');
      expect(a!.functionName).toBe('fnA');
      expect(b!.description).toBe('函数 B 描述');
      expect(b!.inputTypeName).toBe('B');
      expect(b!.functionName).toBe('fnB');
    });

    it('非 export 的同名函数不被识别', () => {
      writeFileSync(
        tempFile,
        `function getWeather() { return "private"; }\nexport function getWeather(input: WeatherInput) { return "public"; }\n`,
      );
      const program = createProgram(tempFile);
      const result = extractToolMetadata(program, tempFile, 'getWeather', sharedMeta);
      // 找到 export 的版本,有 inputTypeName,description 为 undefined(无 JSDoc)
      expect(result).not.toBeNull();
      expect(result!.inputTypeName).toBe('WeatherInput');
      expect(result!.description).toBeUndefined();
    });
  });
});
