import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  serializeTools,
  writeToolsModule,
  hydrateTools,
  generateToolArtifacts,
  generateToolSchemaFileSource,
  getToolSchemaOutputPath,
  getRuntimeToolSchemaPath,
  type SerializedToolRecord,
  type ToolSchemaSource,
} from './generateToolArtifacts';
import { createProgram } from '../ast/createProgram';
import { extractAllTypes } from '../ast/extractHandlerTypes';
import { importWithCacheBust } from '../utils/importWithCacheBust';
import type { ToolManifest } from '../tools/toolTypes';
import type { ToolMetadata } from '../ast/extractToolMetadata';
import { invalidateProgramCache } from '../ast/createProgram';

/**
 * generateToolArtifacts 测试：从 ToolManifest[] 生成 faapi-tools.js + 每个 tool 的 zod.js
 *
 * 覆盖：
 * - serializeTools：序列化 ToolMetadata → SerializedToolRecord（filePath 转产物形式）
 * - hydrateTools：水合 SerializedToolRecord → ToolMetadata
 * - writeToolsModule：写入 faapi-tools.js
 * - getToolSchemaOutputPath / getRuntimeToolSchemaPath：tool zod.js 路径计算
 * - generateToolSchemaFileSource：生成单个 handler.ts 的 zod.js 源码
 * - generateToolArtifacts：端到端主入口
 */
describe('generateToolArtifacts', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(
      tmpdir(),
      `faapi-gen-tool-artifacts-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    // 清理 Program 缓存,避免跨用例干扰
    invalidateProgramCache();
  });

  // ─── serializeTools ──────────────────────────────────────────────────

  describe('serializeTools', () => {
    it('共享 tool filePath 转产物形式(src/tools/... → dist/tools/...)', () => {
      const meta: ToolMetadata = {
        name: 'weather.getWeather',
        functionName: 'getWeather',
        description: '获取天气',
        inputTypeName: 'WeatherInput',
        filePath: 'src/tools/weather/handler.ts',
      };
      const result = serializeTools([meta], 'dist');
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        name: 'weather.getWeather',
        functionName: 'getWeather',
        description: '获取天气',
        inputTypeName: 'WeatherInput',
        filePath: 'dist/tools/weather/handler.js',
      });
    });

    it('无 description/inputTypeName 时字段省略(undefined)', () => {
      const meta: ToolMetadata = {
        name: 'ping',
        functionName: 'ping',
        // description / inputTypeName 均为 undefined
        filePath: 'src/tools/handler.ts',
      };
      const result = serializeTools([meta], 'dist');
      // JSON.stringify 忽略 undefined,但对象属性仍存在(值为 undefined)
      expect(result[0].name).toBe('ping');
      expect(result[0].description).toBeUndefined();
      expect(result[0].inputTypeName).toBeUndefined();
    });

    it('dev 模式 dist 为 .faapi', () => {
      const meta: ToolMetadata = {
        name: 'ping',
        functionName: 'ping',
        filePath: 'src/tools/handler.ts',
      };
      const result = serializeTools([meta], '.faapi');
      expect(result[0].filePath).toBe('.faapi/tools/handler.js');
    });

    it('dist 默认为 dist', () => {
      const meta: ToolMetadata = {
        name: 'ping',
        functionName: 'ping',
        filePath: 'src/tools/handler.ts',
      };
      const result = serializeTools([meta]);
      expect(result[0].filePath).toBe('dist/tools/handler.js');
    });

    it('多个 tool 同时序列化', () => {
      const metas: ToolMetadata[] = [
        {
          name: 'weather.getWeather',
          functionName: 'getWeather',
          description: '获取天气',
          inputTypeName: 'WeatherInput',
          filePath: 'src/tools/weather/handler.ts',
        },
        {
          name: 'web-search.search',
          functionName: 'search',
          description: '网络搜索',
          inputTypeName: 'SearchInput',
          filePath: 'src/tools/web-search/handler.ts',
        },
        {
          name: 'ping',
          functionName: 'ping',
          filePath: 'src/tools/handler.ts',
        },
      ];
      const result = serializeTools(metas, 'dist');
      expect(result).toHaveLength(3);
      expect(result.map((r) => r.name)).toEqual([
        'weather.getWeather',
        'web-search.search',
        'ping',
      ]);
    });
  });

  // ─── hydrateTools ───────────────────────────────────────────────────

  describe('hydrateTools', () => {
    it('字段一一对应还原', () => {
      const serialized: SerializedToolRecord[] = [
        {
          name: 'weather.getWeather',
          functionName: 'getWeather',
          description: '获取天气',
          inputTypeName: 'WeatherInput',
          filePath: 'dist/tools/weather/handler.js',
        },
      ];
      const hydrated = hydrateTools(serialized);
      expect(hydrated).toHaveLength(1);
      expect(hydrated[0]).toEqual({
        name: 'weather.getWeather',
        functionName: 'getWeather',
        description: '获取天气',
        inputTypeName: 'WeatherInput',
        filePath: 'dist/tools/weather/handler.js',
      });
    });

    it('undefined 字段正确还原(缺失字段兜底为 undefined)', () => {
      // 模拟从 JSON.parse 还原后的对象(undefined 字段在 JSON 中被省略)
      const serialized = [
        {
          name: 'ping',
          functionName: 'ping',
          filePath: 'dist/tools/handler.js',
          // description / inputTypeName 缺失
        },
      ] as unknown as SerializedToolRecord[];
      const hydrated = hydrateTools(serialized);
      expect(hydrated[0].name).toBe('ping');
      expect(hydrated[0].description).toBeUndefined();
      expect(hydrated[0].inputTypeName).toBeUndefined();
    });

    it('serializeTools + hydrateTools 往返一致(filePath 保持产物形式)', () => {
      const original: ToolMetadata[] = [
        {
          name: 'weather.getWeather',
          functionName: 'getWeather',
          description: '获取天气',
          inputTypeName: 'WeatherInput',
          filePath: 'src/tools/weather/handler.ts',
        },
        {
          name: 'ping',
          functionName: 'ping',
          filePath: 'src/tools/handler.ts',
        },
      ];
      const serialized = serializeTools(original, 'dist');
      const hydrated = hydrateTools(serialized);
      // filePath 已转为产物形式,其他字段一致
      expect(hydrated[0].filePath).toBe('dist/tools/weather/handler.js');
      expect(hydrated[0].name).toBe(original[0].name);
      expect(hydrated[0].description).toBe(original[0].description);
      expect(hydrated[0].inputTypeName).toBe(original[0].inputTypeName);
      expect(hydrated[1].filePath).toBe('dist/tools/handler.js');
    });
  });

  // ─── writeToolsModule ───────────────────────────────────────────────

  describe('writeToolsModule', () => {
    it('写入 faapi-tools.js,内容含 export const tools', async () => {
      const outputPath = join(tempDir, 'faapi-tools.js');
      const manifest: SerializedToolRecord[] = [
        {
          name: 'weather.getWeather',
          functionName: 'getWeather',
          description: '获取天气',
          inputTypeName: 'WeatherInput',
          filePath: 'dist/tools/weather/handler.js',
        },
      ];
      await writeToolsModule(manifest, outputPath);
      expect(existsSync(outputPath)).toBe(true);

      const content = readFileSync(outputPath, 'utf-8');
      expect(content).toContain('export const tools =');
      expect(content).toContain('weather.getWeather');
      expect(content).toContain('获取天气');
      expect(content).toContain('WeatherInput');
      expect(content).toContain('dist/tools/weather/handler.js');
    });

    it('空清单也写入(空数组)', async () => {
      const outputPath = join(tempDir, 'faapi-tools.js');
      await writeToolsModule([], outputPath);
      expect(existsSync(outputPath)).toBe(true);
      const content = readFileSync(outputPath, 'utf-8');
      expect(content).toContain('export const tools = []');
    });

    it('自动创建目录', async () => {
      const outputPath = join(tempDir, 'nested', 'dir', 'faapi-tools.js');
      await writeToolsModule([], outputPath);
      expect(existsSync(outputPath)).toBe(true);
    });
  });

  // ─── getToolSchemaOutputPath / getRuntimeToolSchemaPath ──────────────

  describe('getToolSchemaOutputPath', () => {
    it('共享 tool:src/tools/weather/handler.ts → dist/tools/weather/zod.js', () => {
      const result = getToolSchemaOutputPath('src/tools/weather/handler.ts', 'dist', '/root');
      expect(result).toBe(join('/root', 'dist', 'tools', 'weather', 'zod.js'));
    });

    it('无子目录:src/tools/handler.ts → dist/tools/zod.js', () => {
      const result = getToolSchemaOutputPath('src/tools/handler.ts', 'dist', '/root');
      expect(result).toBe(join('/root', 'dist', 'tools', 'zod.js'));
    });

    it('dev 模式输出到 .faapi', () => {
      const result = getToolSchemaOutputPath('src/tools/weather/handler.ts', '.faapi', '/root');
      expect(result).toBe(join('/root', '.faapi', 'tools', 'weather', 'zod.js'));
    });
  });

  describe('getRuntimeToolSchemaPath', () => {
    it('dev 模式 filePath 是源码路径(src/...),反推 zod.js 路径', () => {
      const result = getRuntimeToolSchemaPath('src/tools/weather/handler.ts', '.faapi', '/root');
      expect(result).toBe(join('/root', '.faapi', 'tools', 'weather', 'zod.js'));
    });

    it('prod 模式 filePath 是产物路径(dist/...),反推 zod.js 路径', () => {
      const result = getRuntimeToolSchemaPath('dist/tools/weather/handler.js', 'dist', '/root');
      expect(result).toBe(join('/root', 'dist', 'tools', 'weather', 'zod.js'));
    });
  });

  // ─── generateToolSchemaFileSource ────────────────────────────────────

  describe('generateToolSchemaFileSource', () => {
    /** 构造 ToolSchemaSource(从源码提取类型) */
    function makeSources(file: string, inputTypeNames: string[]): ToolSchemaSource[] {
      const program = createProgram(file);
      const allTypes = extractAllTypes(program, file);
      return inputTypeNames.map((typeName) => ({
        name: typeName, // 测试中 name 与 inputTypeName 一致
        filePath: file,
        schemaName: typeName,
        typeInfo: allTypes.get(typeName) ?? null,
      }));
    }

    it('生成 zod.js 源码(含 import 和 export const Schema)', () => {
      const file = join(tempDir, 'weather.ts');
      writeFileSync(
        file,
        `export interface WeatherInput {
  city: string;
}
export function getWeather(input: WeatherInput) { return input; }
`,
      );

      const sources = makeSources(file, ['WeatherInput']);
      const allTypes = extractAllTypes(createProgram(file), file);
      const source = generateToolSchemaFileSource(
        sources,
        (name) => allTypes.get(name)?.runtimeType,
        '../../faapi-helpers.js',
      );

      expect(source).toContain("import { z } from 'zod'");
      // schema 名 = inputTypeName + Schema 后缀
      expect(source).toContain('export const WeatherInputSchema');
      expect(source).toContain('z.string()');
    });

    it('tool schema coerce=false:无 preprocess(与 body 一致,JSON 输入)', () => {
      const file = join(tempDir, 'weather.ts');
      writeFileSync(
        file,
        `export interface WeatherInput {
  page: number;
  active?: boolean;
}
export function getWeather(input: WeatherInput) { return input; }
`,
      );

      const sources = makeSources(file, ['WeatherInput']);
      const allTypes = extractAllTypes(createProgram(file), file);
      const source = generateToolSchemaFileSource(
        sources,
        (name) => allTypes.get(name)?.runtimeType,
        '../../faapi-helpers.js',
      );

      // tool schema coerce=false,number/boolean 字段不应有 z.preprocess
      expect(source).not.toContain('z.preprocess');
      // 不引用 faapi-helpers.js(coerce=false 不需要公用函数)
      expect(source).not.toContain('faapi-helpers.js');
    });

    it('一个 handler.ts 多个 tool 合并到同一 zod.js(各自导出 schema)', () => {
      const file = join(tempDir, 'math.ts');
      writeFileSync(
        file,
        `export interface AddInput { a: number; b: number; }
export interface MultiplyInput { a: number; b: number; }
export function add(input: AddInput) { return input.a + input.b; }
export function multiply(input: MultiplyInput) { return input.a * input.b; }
`,
      );

      const sources = makeSources(file, ['AddInput', 'MultiplyInput']);
      const allTypes = extractAllTypes(createProgram(file), file);
      const source = generateToolSchemaFileSource(
        sources,
        (name) => allTypes.get(name)?.runtimeType,
        '../../faapi-helpers.js',
      );

      expect(source).toContain('export const AddInputSchema');
      expect(source).toContain('export const MultiplyInputSchema');
    });

    it('inputTypeName 为 null 的 tool 不导出对应 Schema', () => {
      const file = join(tempDir, 'ping.ts');
      writeFileSync(file, `export function ping() { return 'pong'; }\n`);

      // 构造无 inputTypeName 的 source(typeInfo 为 null)
      const sources: ToolSchemaSource[] = [
        {
          name: 'ping',
          filePath: file,
          schemaName: 'ping',
          typeInfo: null,
        },
      ];
      const allTypes = extractAllTypes(createProgram(file), file);
      const source = generateToolSchemaFileSource(
        sources,
        (name) => allTypes.get(name)?.runtimeType,
        '../../faapi-helpers.js',
      );

      // 仍含 import 语句
      expect(source).toContain("import { z } from 'zod'");
      // 不导出 pingSchema
      expect(source).not.toContain('export const pingSchema');
    });

    it('循环引用用 z.lazy', () => {
      const file = join(tempDir, 'tree.ts');
      writeFileSync(
        file,
        `export interface TreeInput {
  tree: TreeNode;
}
export interface TreeNode {
  value: number;
  children?: TreeNode[];
}
export function tree(input: TreeInput) { return input; }
`,
      );

      const sources = makeSources(file, ['TreeInput']);
      const allTypes = extractAllTypes(createProgram(file), file);
      const source = generateToolSchemaFileSource(
        sources,
        (name) => allTypes.get(name)?.runtimeType,
        '../../faapi-helpers.js',
      );
      expect(source).toContain('z.lazy');
      expect(source).toContain('TreeNodeSchema');
    });
  });

  // ─── generateToolArtifacts(端到端主入口) ──────────────────────────────

  describe('generateToolArtifacts', () => {
    /** 创建共享 tool fixture */
    function writeSharedTool(relPath: string, content: string): string {
      const absPath = join(tempDir, ...relPath.split('/'));
      mkdirSync(join(tempDir, ...relPath.split('/').slice(0, -1)), { recursive: true });
      writeFileSync(absPath, content);
      return relPath;
    }

    it('从 ToolManifest[] 生成 faapi-tools.js + 每个 tool 的 zod.js', async () => {
      writeSharedTool(
        'src/tools/weather/handler.ts',
        `export interface WeatherInput {
  city: string;
}
/**
 * 获取天气
 * @param input 城市名
 */
export function getWeather(input: WeatherInput) { return 'sunny'; }
`,
      );

      const tools: ToolManifest[] = [
        {
          name: 'weather.getWeather',
          functionName: 'getWeather',
          filePath: 'src/tools/weather/handler.ts',
        },
      ];
      const dist = join(tempDir, 'dist');
      const metadata = await generateToolArtifacts(tools, tempDir, dist);

      // 返回值是 AST 增强后的 ToolMetadata
      expect(metadata).toHaveLength(1);
      expect(metadata[0].name).toBe('weather.getWeather');
      expect(metadata[0].description).toBe('获取天气');
      expect(metadata[0].inputTypeName).toBe('WeatherInput');

      // faapi-tools.js 生成
      const toolsPath = join(dist, 'faapi-tools.js');
      expect(existsSync(toolsPath)).toBe(true);
      const toolsContent = readFileSync(toolsPath, 'utf-8');
      expect(toolsContent).toContain('export const tools =');
      expect(toolsContent).toContain('weather.getWeather');
      expect(toolsContent).toContain('获取天气');
      expect(toolsContent).toContain('WeatherInput');
      expect(toolsContent).toContain('dist/tools/weather/handler.js');

      // zod.js 生成
      const zodPath = join(dist, 'tools', 'weather', 'zod.js');
      expect(existsSync(zodPath)).toBe(true);
      const zodContent = readFileSync(zodPath, 'utf-8');
      expect(zodContent).toContain('export const WeatherInputSchema');
    });

    it('无 inputTypeName 的 tool 不生成 zod.js', async () => {
      writeSharedTool(
        'src/tools/handler.ts',
        `/** 健康检查 */
export function ping() { return 'pong'; }
`,
      );

      const tools: ToolManifest[] = [
        {
          name: 'ping',
          functionName: 'ping',
          filePath: 'src/tools/handler.ts',
        },
      ];
      const dist = join(tempDir, 'dist');
      const metadata = await generateToolArtifacts(tools, tempDir, dist);

      // faapi-tools.js 仍生成,但 inputTypeName 字段省略
      const toolsContent = readFileSync(join(dist, 'faapi-tools.js'), 'utf-8');
      expect(toolsContent).toContain('ping');
      // JSON.stringify 忽略 undefined 字段,inputTypeName 不写入
      expect(toolsContent).not.toContain('inputTypeName');

      // 不生成 zod.js(无 inputTypeName)
      expect(existsSync(join(dist, 'tools', 'zod.js'))).toBe(false);

      // metadata 含 description 但 inputTypeName 为 undefined
      expect(metadata[0].description).toBe('健康检查');
      expect(metadata[0].inputTypeName).toBeUndefined();
    });

    it('一个 handler.ts 多个 tool 共享同一 zod.js', async () => {
      writeSharedTool(
        'src/tools/math/handler.ts',
        `export interface AddInput { a: number; b: number; }
export interface MultiplyInput { a: number; b: number; }
export function add(input: AddInput) { return input.a + input.b; }
export function multiply(input: MultiplyInput) { return input.a * input.b; }
`,
      );

      const tools: ToolManifest[] = [
        {
          name: 'math.add',
          functionName: 'add',
          filePath: 'src/tools/math/handler.ts',
        },
        {
          name: 'math.multiply',
          functionName: 'multiply',
          filePath: 'src/tools/math/handler.ts',
        },
      ];
      const dist = join(tempDir, 'dist');
      await generateToolArtifacts(tools, tempDir, dist);

      // 只生成一个 zod.js(同文件合并)
      const zodPath = join(dist, 'tools', 'math', 'zod.js');
      expect(existsSync(zodPath)).toBe(true);
      const zodContent = readFileSync(zodPath, 'utf-8');
      expect(zodContent).toContain('export const AddInputSchema');
      expect(zodContent).toContain('export const MultiplyInputSchema');

      // faapi-tools.js 含两个 tool 记录
      const toolsContent = readFileSync(join(dist, 'faapi-tools.js'), 'utf-8');
      expect(toolsContent).toContain('math.add');
      expect(toolsContent).toContain('math.multiply');
    });

    it('skipSchema=true 时只生成 faapi-tools.js,不生成 zod.js', async () => {
      writeSharedTool(
        'src/tools/weather/handler.ts',
        `/** 获取天气 */
export interface WeatherInput { city: string; }
export function getWeather(input: WeatherInput) { return 'sunny'; }
`,
      );

      const tools: ToolManifest[] = [
        {
          name: 'weather.getWeather',
          functionName: 'getWeather',
          filePath: 'src/tools/weather/handler.ts',
        },
      ];
      const dist = join(tempDir, '.faapi');
      await generateToolArtifacts(tools, tempDir, dist, { skipSchema: true });

      // faapi-tools.js 生成
      expect(existsSync(join(dist, 'faapi-tools.js'))).toBe(true);
      // zod.js 不生成
      expect(existsSync(join(dist, 'tools', 'weather', 'zod.js'))).toBe(false);
    });

    it('空清单不报错(faapi-tools.js 为空数组)', async () => {
      const dist = join(tempDir, 'dist');
      const metadata = await generateToolArtifacts([], tempDir, dist);
      expect(metadata).toEqual([]);
      expect(existsSync(join(dist, 'faapi-tools.js'))).toBe(true);
      const content = readFileSync(join(dist, 'faapi-tools.js'), 'utf-8');
      expect(content).toContain('export const tools = []');
    });

    it('生成的 zod.js 可被 import 并用于 zod safeParse', async () => {
      writeSharedTool(
        'src/tools/weather/handler.ts',
        `export interface WeatherInput { city: string; }
export function getWeather(input: WeatherInput) { return input; }
`,
      );

      const tools: ToolManifest[] = [
        {
          name: 'weather.getWeather',
          functionName: 'getWeather',
          filePath: 'src/tools/weather/handler.ts',
        },
      ];
      const dist = join(tempDir, 'dist');
      await generateToolArtifacts(tools, tempDir, dist);

      const zodPath = join(dist, 'tools', 'weather', 'zod.js');
      const mod = (await importWithCacheBust(zodPath)) as {
        WeatherInputSchema: { safeParse: (v: unknown) => { success: boolean } };
      };

      expect(mod.WeatherInputSchema).toBeDefined();

      // 校验正确输入
      const ok = mod.WeatherInputSchema.safeParse({ city: 'shanghai' });
      expect(ok.success).toBe(true);

      // 校验缺必填字段
      const missing = mod.WeatherInputSchema.safeParse({});
      expect(missing.success).toBe(false);
    });

    it('faapi-tools.js 可被 import 还原为 ToolMetadata[]', async () => {
      writeSharedTool(
        'src/tools/weather/handler.ts',
        `export interface WeatherInput { city: string; }
/** 获取天气 */
export function getWeather(input: WeatherInput) { return 'sunny'; }
`,
      );

      const tools: ToolManifest[] = [
        {
          name: 'weather.getWeather',
          functionName: 'getWeather',
          filePath: 'src/tools/weather/handler.ts',
        },
      ];
      // dist 用相对路径(与 generateRoutes 测试一致,避免 toProdFilePath 拼出绝对路径)
      const dist = 'dist';
      await generateToolArtifacts(tools, tempDir, dist);

      // import faapi-tools.js
      const toolsPath = join(tempDir, dist, 'faapi-tools.js');
      const mod = (await importWithCacheBust(toolsPath)) as {
        tools: SerializedToolRecord[];
      };
      expect(mod.tools).toHaveLength(1);
      expect(mod.tools[0].name).toBe('weather.getWeather');
      expect(mod.tools[0].description).toBe('获取天气');
      expect(mod.tools[0].inputTypeName).toBe('WeatherInput');
      expect(mod.tools[0].filePath).toBe('dist/tools/weather/handler.js');

      // 用 hydrateTools 还原
      const hydrated = hydrateTools(mod.tools);
      expect(hydrated).toHaveLength(1);
      expect(hydrated[0].name).toBe('weather.getWeather');
      expect(hydrated[0].description).toBe('获取天气');
      expect(hydrated[0].inputTypeName).toBe('WeatherInput');
    });

    it('dev 模式 dist 为 .faapi', async () => {
      writeSharedTool(
        'src/tools/weather/handler.ts',
        `export interface WeatherInput { city: string; }
export function getWeather(input: WeatherInput) { return input; }
`,
      );

      const tools: ToolManifest[] = [
        {
          name: 'weather.getWeather',
          functionName: 'getWeather',
          filePath: 'src/tools/weather/handler.ts',
        },
      ];
      const dist = join(tempDir, '.faapi');
      await generateToolArtifacts(tools, tempDir, dist);

      expect(existsSync(join(dist, 'faapi-tools.js'))).toBe(true);
      expect(existsSync(join(dist, 'tools', 'weather', 'zod.js'))).toBe(true);
    });
  });
});
