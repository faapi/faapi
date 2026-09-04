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
    name: 'weather.getWeather',
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
        `/** @tool weather.current */\nexport function getWeather(input: WeatherInput) { return "sunny"; }\n`,
      );
      const program = createProgram(tempFile);
      const result = extractToolMetadata(program, tempFile, 'getWeather', sharedMeta);
      expect(result).not.toBeNull();
      expect(result!.description).toBeUndefined();
    });
  });

  describe('@tool 覆盖名', () => {
    it('@tool 标签覆盖 name', () => {
      writeFileSync(
        tempFile,
        `/** @tool weather.current */\nexport function getWeather(input: WeatherInput) { return "sunny"; }\n`,
      );
      const program = createProgram(tempFile);
      const result = extractToolMetadata(program, tempFile, 'getWeather', sharedMeta);
      expect(result).not.toBeNull();
      expect(result!.name).toBe('weather.current');
    });

    it('描述 + @tool 标签同时存在,name 使用 @tool 值', () => {
      writeFileSync(
        tempFile,
        `/**\n * 获取当前天气\n * @tool weather.current\n */\nexport function getWeather(input: WeatherInput) { return "sunny"; }\n`,
      );
      const program = createProgram(tempFile);
      const result = extractToolMetadata(program, tempFile, 'getWeather', sharedMeta);
      expect(result).not.toBeNull();
      expect(result!.name).toBe('weather.current');
      expect(result!.description).toBe('获取当前天气');
    });

    it('@tool 标签值带花括号时去括号', () => {
      writeFileSync(
        tempFile,
        `/** @tool {weather.current} */\nexport function getWeather(input: WeatherInput) { return "sunny"; }\n`,
      );
      const program = createProgram(tempFile);
      const result = extractToolMetadata(program, tempFile, 'getWeather', sharedMeta);
      expect(result).not.toBeNull();
      expect(result!.name).toBe('weather.current');
    });

    it('无 @tool 标签时 name 使用 pathMeta.name', () => {
      writeFileSync(
        tempFile,
        `/** 获取天气 */\nexport function getWeather(input: WeatherInput) { return "sunny"; }\n`,
      );
      const program = createProgram(tempFile);
      const result = extractToolMetadata(program, tempFile, 'getWeather', sharedMeta);
      expect(result).not.toBeNull();
      expect(result!.name).toBe('weather.getWeather');
    });

    it('@tool 标签无值时 name 回退到 pathMeta.name', () => {
      writeFileSync(
        tempFile,
        `/**\n * 获取天气\n * @tool\n */\nexport function getWeather(input: WeatherInput) { return "sunny"; }\n`,
      );
      const program = createProgram(tempFile);
      const result = extractToolMetadata(program, tempFile, 'getWeather', sharedMeta);
      expect(result).not.toBeNull();
      expect(result!.name).toBe('weather.getWeather');
      expect(result!.description).toBe('获取天气');
    });

    it('@tool 覆盖不影响 functionName(仍是源码导出名)', () => {
      writeFileSync(
        tempFile,
        `/** @tool weather.current */\nexport function getWeather(input: WeatherInput) { return "sunny"; }\n`,
      );
      const program = createProgram(tempFile);
      const result = extractToolMetadata(program, tempFile, 'getWeather', sharedMeta);
      expect(result).not.toBeNull();
      expect(result!.functionName).toBe('getWeather');
      expect(result!.name).toBe('weather.current');
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

    it('箭头函数 @tool 覆盖生效', () => {
      writeFileSync(
        tempFile,
        `/** @tool weather.current */\nexport const getWeather = (input: WeatherInput) => "sunny";\n`,
      );
      const program = createProgram(tempFile);
      const result = extractToolMetadata(program, tempFile, 'getWeather', sharedMeta);
      expect(result).not.toBeNull();
      expect(result!.name).toBe('weather.current');
    });
  });

  describe('路径推导字段透传', () => {
    it('共享 tool: filePath/name 从 pathMeta 透传', () => {
      writeFileSync(tempFile, `export function getWeather() { return "sunny"; }\n`);
      const program = createProgram(tempFile);
      const result = extractToolMetadata(program, tempFile, 'getWeather', sharedMeta);
      expect(result).not.toBeNull();
      expect(result!.name).toBe('weather.getWeather');
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
