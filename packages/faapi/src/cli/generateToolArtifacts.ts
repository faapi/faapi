import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { ToolManifestList } from '../tools/toolTypes';
import type { ToolMetadata } from '../ast/extractToolMetadata';
import { extractToolMetadata } from '../ast/extractToolMetadata';
import { createPrograms } from '../ast/createProgram';
import {
  extractTypeInfo,
  createLazyTypeResolver,
  type HandlerTypeInfo,
  type LazyTypeResolver,
} from '../ast/extractHandlerTypes';
import type { RuntimeType } from '../ast/resolveTypeNode';
import {
  generateZodSchemaSource,
  generateHelpersFileSource,
  usesCoerceHelpers,
  HELPERS_FILENAME,
} from '../ast/generateZodSchema';
import { getHelpersImportPath } from './generateSchemaFiles';

/**
 * 序列化的 tool manifest 记录(可写入 JS 模块,无函数引用)
 *
 * 与 [ToolMetadata](../ast/extractToolMetadata.md) 字段一一对应,仅 `filePath`
 * 由源码形式(`src/...`)转为产物形式(`<dist>/...`,打平 `src/` 前缀 + dist 前缀 + `.js`)。
 *
 * `undefined` 字段(description / inputTypeName)在 JSON.stringify 时自动省略,
 * 水合时通过 `??` 兜底为 undefined。
 */
export interface SerializedToolRecord {
  /** tool 名(`@tool` 覆盖值 或 路径推导值) */
  name: string;
  /** 源码中的导出函数名(供 loadToolModule 在 handler.js 中按名 import) */
  functionName: string;
  /** JSDoc 描述(对 LLM 可见) */
  description?: string;
  /** 第一个参数 interface 名(用于从 zod.js 加载 schema) */
  inputTypeName?: string;
  /** 产物形式路径(如 `dist/tools/weather/handler.js`),供运行时 import tool.js */
  filePath: string;
}

/**
 * 单个 tool 的 schema 提取结果
 *
 * 与 [RouteSchemaSource](./collectRouteSchemaSources.md) 对称,但 schema key 用 tool 名而非 urlPath。
 */
export interface ToolSchemaSource {
  /** tool 名(含 `@tool` 覆盖),用作注释标识 */
  name: string;
  /** 源文件绝对路径(用于 generateToolArtifacts 按文件分组生成 zod.js) */
  filePath: string;
  /** schema 名 = inputTypeName(导出 `${inputTypeName}Schema`) */
  schemaName: string;
  /** AST 提取的类型信息,null 时不导出 Schema */
  typeInfo: HandlerTypeInfo | null;
}

/**
 * faapi-tools.js 文件名(与 faapi-routes.js 同构)
 */
const TOOLS_FILE = 'faapi-tools.js';

/**
 * 源文件路径 → tool zod.js 产物路径
 *
 * 每个 tool handler 目录下生成一个 `zod.js`(与 `handler.js` 同级,文件名固定为 `zod.js`):
 * - `src/tools/weather/handler.ts` → `<dist>/tools/weather/zod.js`
 * - `src/tools/web-search/handler.ts` → `<dist>/tools/web-search/zod.js`
 *
 * 路径计算与 [getSchemaOutputPath](./generateSchemaFiles.ts) 一致——剥离 `src/` 前缀打平产物结构,
 * basename 固定为 `zod.js`(与 handler.js 同级)。
 *
 * @param sourceFile 源文件相对路径(相对 rootDir,如 `src/tools/weather/handler.ts`)
 * @param dist 输出目录(如 `dist` 或 `.faapi`)
 * @param rootDir 项目根目录
 */
export function getToolSchemaOutputPath(sourceFile: string, dist: string, rootDir: string): string {
  let rel = sourceFile.replace(/\\/g, '/');
  if (rel.startsWith('src/')) {
    rel = rel.slice(4);
  }
  const idx = rel.lastIndexOf('/');
  const relDir = idx >= 0 ? rel.slice(0, idx) : '';
  return path.resolve(rootDir, dist, relDir, 'zod.js');
}

/**
 * 运行时从 tool.filePath(产物形式)计算对应 zod.js 绝对路径
 *
 * 与 [getRuntimeSchemaPath](./generateSchemaFiles.ts) 同构,统一处理 dev/prod 两种模式:
 * - dev:filePath 是源码路径(`src/...`),strip `src/` 前缀 + join dist
 * - prod:filePath 是产物路径(`<dist>/...`),strip `<dist>/` 前缀 + join dist
 *
 * basename 固定为 `zod.js`(与 handler.js 同级)。
 *
 * @param filePath tool.filePath(dev 为源码路径,prod 为产物路径)
 * @param dist 输出目录(如 `dist` 或 `.faapi`)
 * @param rootDir 项目根目录
 */
export function getRuntimeToolSchemaPath(filePath: string, dist: string, rootDir: string): string {
  let rel = filePath.replace(/\\/g, '/');
  if (rel.startsWith('src/')) {
    rel = rel.slice(4);
  } else if (rel.startsWith(`${dist}/`)) {
    rel = rel.slice(dist.length + 1);
  }
  const idx = rel.lastIndexOf('/');
  const relDir = idx >= 0 ? rel.slice(0, idx) : '';
  return path.resolve(rootDir, dist, relDir, 'zod.js');
}

/**
 * 把源码 filePath(`src/tools/weather/handler.ts`)转为产物路径(`<dist>/tools/weather/handler.js`)
 *
 * 产物结构打平 `src/` 前缀:去掉 `src/`,加 dist 前缀,`.ts` → `.js`。
 *
 * 与 [generateRoutes.toProdFilePath](./generateRoutes.ts) 同构,但不强制加 dist 前缀
 * (若 filePath 已是 `<dist>/...` 形式则保持)。
 */
function toProdFilePath(filePath: string, dist: string): string {
  let rel = filePath.replace(/\\/g, '/');
  if (rel.startsWith('src/')) {
    rel = rel.slice(4);
  }
  const jsPath = rel.replace(/\.ts$/, '.js');
  return jsPath.startsWith(`${dist}/`) ? jsPath : `${dist}/${jsPath}`;
}

/**
 * 序列化 tool 清单为可写入 JS 模块的结构
 *
 * - `filePath` 转为产物形式(打平 `src/` 前缀 + dist 前缀 + `.js`)
 * - 其他字段(name/functionName/description/inputTypeName)直接透传
 * - `undefined` 字段在 JSON.stringify 时自动省略
 *
 * @param tools AST 增强后的 ToolMetadata[](由 generateToolArtifacts 内部从 ToolManifest 增强)
 * @param dist 产物目录(默认 `dist`),用于转换 filePath
 */
export function serializeTools(
  tools: ToolMetadata[],
  dist: string = 'dist',
): SerializedToolRecord[] {
  return tools.map((t) => ({
    name: t.name,
    functionName: t.functionName,
    description: t.description,
    inputTypeName: t.inputTypeName,
    filePath: toProdFilePath(t.filePath, dist),
  }));
}

/**
 * 把序列化的 tool 清单写入 faapi-tools.js
 *
 * 生成 ESM 模块,运行时 `createAppCore` 通过 `importWithCacheBust` 加载。
 * 用 JSON.stringify 嵌入,保证字符串转义安全(与 `writeRoutesModule` 一致)。
 */
export async function writeToolsModule(
  manifest: SerializedToolRecord[],
  outputPath: string,
): Promise<void> {
  const dir = path.dirname(outputPath);
  await fs.mkdir(dir, { recursive: true });

  const content = `// 自动生成,请勿手动编辑(faapi build/dev 产物)
export const tools = ${JSON.stringify(manifest, null, 2)};
`;
  await fs.writeFile(outputPath, content, 'utf-8');
}

/**
 * 从序列化清单水合还原 ToolMetadata[]
 *
 * 字段一一对应(无函数引用需还原)。`undefined` 字段在 JSON.parse 时缺失,
 * 通过 `??` 兜底为 undefined(保证 `ToolMetadata` 类型完整)。
 */
export function hydrateTools(manifest: SerializedToolRecord[]): ToolMetadata[] {
  return manifest.map((t) => ({
    name: t.name,
    functionName: t.functionName,
    description: t.description ?? undefined,
    inputTypeName: t.inputTypeName ?? undefined,
    filePath: t.filePath,
  }));
}

/**
 * 从 ToolMetadata[] 收集 schema 提取所需的原始数据
 *
 * 与 [collectRouteSchemaSources](./collectRouteSchemaSources.ts) 对称,但:
 * - 按 tool handler.ts 文件分组(同一 handler.ts 多个 tool 合并到一个 zod.js)
 * - schema 名 = inputTypeName(导出 `${inputTypeName}Schema`,与路由的 `<METHOD><InputType>Schema` 不同)
 * - coerce=false(tool input 来自 LLM JSON 调用,与 body 一致,无需字符串转换)
 *
 * 跳过 inputTypeName 为 undefined 的 tool(无参数/无类型标注/内联类型字面量),
 * 不生成对应 schema(与路由的"无类型声明的方法不导出 Schema"对齐)。
 *
 * 与路由的 collectRouteSchemaSources 一致采用惰性解析：入口类型（inputTypeName）
 * 立即解析且必须严格校验，ref 按需解析并缓存——与 tool 无关的类型零开销。
 *
 * @returns sources(用于生成 zod.js) + resolversByFile(用于解析 ref)
 */
function collectToolSchemaSources(
  tools: ToolMetadata[],
  rootDir: string,
): {
  sources: ToolSchemaSource[];
  resolversByFile: Map<string, LazyTypeResolver>;
} {
  // 按文件分组 tool(同一 handler.ts 多个 tool 合并到一个 zod.js)
  const toolsByFile = new Map<string, ToolMetadata[]>();
  for (const tool of tools) {
    if (!tool.inputTypeName) continue; // 跳过无 inputTypeName 的 tool
    const absPath = path.resolve(rootDir, tool.filePath);
    let list = toolsByFile.get(absPath);
    if (!list) {
      list = [];
      toolsByFile.set(absPath, list);
    }
    list.push(tool);
  }

  // 批量共享 Program:同一次提取只创建一个 Program,避免逐文件全量解析
  const programByFile = createPrograms([...toolsByFile.keys()]);
  const resolversByFile = new Map<string, LazyTypeResolver>();
  for (const filePath of toolsByFile.keys()) {
    resolversByFile.set(filePath, createLazyTypeResolver(programByFile.get(filePath)!, filePath));
  }

  // 为每个 tool 提取 schema
  const sources: ToolSchemaSource[] = [];
  for (const [filePath, fileTools] of toolsByFile) {
    const program = programByFile.get(filePath)!;
    for (const tool of fileTools) {
      // inputTypeName 已在外层过滤,这里一定非空(防御性兜底)
      const inputTypeName = tool.inputTypeName!;
      const typeInfo = extractTypeInfo(program, filePath, inputTypeName); // 入口类型,严格解析
      sources.push({
        name: tool.name,
        filePath,
        schemaName: inputTypeName, // schema 名 = inputTypeName
        typeInfo,
      });
    }
  }

  return { sources, resolversByFile };
}

/**
 * 生成单个 tool handler.ts 的 zod.js 源码
 *
 * 自包含:[extractAllTypes](../ast/extractHandlerTypes.md) 在 AST 阶段已通过 TypeScript checker
 * 内联跨文件类型,每个 zod.js 无需 import 其他 zod.js。`ref` 仅用于同文件内的循环引用
 * (通过 `z.lazy` 处理)。
 *
 * 导出格式:
 * - `${inputTypeName}Schema`:zod schema 对象(用于 safeParse 校验)
 *
 * 与 [generateSchemaFileSource](./generateSchemaFiles.ts) 的差异:
 * - schema 名直接取自 `inputTypeName`(无 HTTP 方法前缀)
 * - coerce=false(tool input 来自 LLM JSON 调用,与 body 一致)
 *
 * 无 inputTypeName 的 tool 不导出对应 Schema(collectToolSchemaSources 已过滤)。
 *
 * @param sources 同一文件的 schema 提取结果(含多个 tool)
 * @param resolveType ref 解析函数(解析循环引用中的 ref):名称 → 运行时类型,未声明返回 undefined
 * @param helpersImportPath 到 faapi-helpers.js 的相对 import 路径(如 `../../faapi-helpers.js`)。
 *        传空字符串表示不注入 coerce helpers 的 import(用于无 helpers 引用的文件或测试场景)。
 */
export function generateToolSchemaFileSource(
  sources: ToolSchemaSource[],
  resolveType: (name: string) => RuntimeType | undefined,
  helpersImportPath: string,
): string {
  const lines: string[] = ["import { z } from 'zod';"];

  // 先生成所有 schema 代码,暂存到 schemaBlocks
  const schemaBlocks: string[] = [];
  for (const source of sources) {
    const { schemaName, typeInfo } = source;
    if (!typeInfo) {
      // 无类型声明,不导出对应 Schema
      continue;
    }

    // tool schema coerce=false(input 来自 LLM JSON 调用,与 body 一致)
    const coerce = false;

    const block = [`// ${source.name} → ${schemaName}`];
    // generateZodSchemaSource 自带 import 语句,剥离后由本函数统一管理 import
    // 传入 schemaName 作为 exportName,确保导出名与运行时查找一致(`${inputTypeName}Schema`)
    const schemaCode = generateZodSchemaSource(typeInfo, resolveType, schemaName, coerce).replace(
      /^import \{ z \} from 'zod';\s*\n\s*\n/,
      '',
    );
    block.push(schemaCode);
    block.push('');
    schemaBlocks.push(block.join('\n'));
  }

  // 检测是否有 schema 引用了 coerce 公用函数(Map/Set 还原,即使 coerce=false 也可能引用)
  const allSchemaCode = schemaBlocks.join('\n');
  if (helpersImportPath && usesCoerceHelpers(allSchemaCode)) {
    lines.push(
      `import { coerceNumber, coerceBoolean, coerceMap, coerceSet } from '${helpersImportPath}';`,
    );
  }
  lines.push('');

  lines.push(...schemaBlocks);

  return lines.join('\n').replace(/\n+$/, '\n');
}

/**
 * 检测并生成 faapi-helpers.js(若不存在且 schema 引用了公用函数)
 *
 * tool schema 在两种场景下会引用 faapi-helpers.js 的公用变量:
 * 1. Map/Set 字段:即使 coerce=false 也引用 `coerceMap` / `coerceSet`(JSON.parse 出来的是数组/对象,需还原)
 * 2. number/boolean 字段:coerce=true 时引用 `coerceNumber` / `coerceBoolean`
 *    (tool schema coerce=false,不会触发此场景)
 *
 * 与 [generateSchemaFiles](./generateSchemaFiles.ts) 共享同一份 `faapi-helpers.js`——
 * 若文件已存在则不重复生成(路由 schema 生成阶段可能已生成)。
 */
async function maybeGenerateHelpers(allSourceCode: string, distDir: string): Promise<void> {
  if (!usesCoerceHelpers(allSourceCode)) return;
  const helpersPath = path.resolve(distDir, HELPERS_FILENAME);
  if (existsSync(helpersPath)) return;
  await fs.mkdir(path.dirname(helpersPath), { recursive: true });
  await fs.writeFile(helpersPath, generateHelpersFileSource(), 'utf-8');
}

/**
 * 主入口:从 ToolManifest[] 生成 faapi-tools.js + 每个 tool 的 zod.js
 *
 * 内部流程:
 * 1. 对每个 ToolManifest 调 `createProgram` + `extractToolMetadata` → ToolMetadata[]
 *    (AST 增强:补全 description / inputTypeName / `@tool` 覆盖后的 name)
 * 2. `serializeTools(metadata, dist)` → SerializedToolRecord[](filePath 转产物形式)
 * 3. `writeToolsModule(serialized, faapiToolsPath)` → 写入 `<dist>/faapi-tools.js`
 * 4. 若 `skipSchema=true`(dev 按需模式)→ 返回,不生成 zod.js
 * 5. `collectToolSchemaSources` 从 ToolMetadata[] 收集 schema 源数据(按文件分组)
 * 6. 为每个文件计算 `helpersImportPath` + 生成 zod.js 源码(暂存)
 * 7. `maybeGenerateHelpers` 检测并生成/复用 `faapi-helpers.js`
 * 8. 并行写入所有 zod.js
 *
 * @param tools scanTools 产出的 ToolManifest[](仅路径推导字段)
 * @param rootDir 项目根目录
 * @param dist 产物目录(`.faapi` 或 `dist`)
 * @param options.skipSchema 跳过 zod.js 生成(dev 按需模式启动时仅生成清单)
 * @returns AST 增强后的 ToolMetadata[](供调用方日志/调试)
 */
export async function generateToolArtifacts(
  tools: ToolManifestList,
  rootDir: string,
  dist: string,
  options?: { skipSchema?: boolean },
): Promise<ToolMetadata[]> {
  // 1. AST 增强:对每个 manifest 调 extractToolMetadata(批量共享 Program)
  const metadata: ToolMetadata[] = [];
  const programByFile = createPrograms(tools.map((m) => path.resolve(rootDir, m.filePath)));
  for (const manifest of tools) {
    const absPath = path.resolve(rootDir, manifest.filePath);
    const program = programByFile.get(absPath)!;
    const result = extractToolMetadata(program, absPath, manifest.functionName, {
      name: manifest.name,
      filePath: manifest.filePath,
    });
    if (result) {
      metadata.push(result);
    }
  }

  // 2. 序列化 + 写入 faapi-tools.js
  const serialized = serializeTools(metadata, dist);
  const toolsPath = path.resolve(rootDir, dist, TOOLS_FILE);
  await writeToolsModule(serialized, toolsPath);

  // 4. dev 按需模式:跳过 zod.js 生成(首次请求时由 ensureToolSchemaGenerated 按需生成)
  if (options?.skipSchema) {
    return metadata;
  }

  // 5-8. 生成 zod.js
  if (metadata.length === 0) {
    return metadata;
  }

  const { sources, resolversByFile } = collectToolSchemaSources(metadata, rootDir);
  if (sources.length === 0) {
    return metadata; // 无 inputTypeName 的 tool,不生成 zod.js
  }

  // 按文件分组 sources(同一 handler.ts 多个 tool 合并到一个 zod.js)
  const sourcesByFile = new Map<string, ToolSchemaSource[]>();
  for (const source of sources) {
    let list = sourcesByFile.get(source.filePath);
    if (!list) {
      list = [];
      sourcesByFile.set(source.filePath, list);
    }
    list.push(source);
  }

  // 为每个文件生成 zod.js 源码(先暂存,用于检测是否需要 helpers)
  const fileEntries: { outputPath: string; source: string }[] = [];
  for (const [filePath, fileSources] of sourcesByFile) {
    const relFile = path.relative(rootDir, filePath).replace(/\\/g, '/');
    const outputPath = getToolSchemaOutputPath(relFile, dist, rootDir);
    const resolver = resolversByFile.get(filePath);

    // 计算 zod.js 所在目录相对 dist 的路径(用于 import helpers)
    let relForDir = relFile;
    if (relForDir.startsWith('src/')) {
      relForDir = relForDir.slice(4);
    }
    const dirIdx = relForDir.lastIndexOf('/');
    const zodRelDir = dirIdx >= 0 ? relForDir.slice(0, dirIdx) : '';
    const helpersImportPath = getHelpersImportPath(zodRelDir);

    const source = generateToolSchemaFileSource(
      fileSources,
      (name) => resolver?.resolve(name)?.runtimeType,
      helpersImportPath,
    );
    fileEntries.push({ outputPath, source });
  }

  // 检测是否需要生成 faapi-helpers.js
  const allSourceCode = fileEntries.map((e) => e.source).join('\n');
  const distDir = path.resolve(rootDir, dist);
  await maybeGenerateHelpers(allSourceCode, distDir);

  // 并行写入所有 zod.js
  await Promise.all(
    fileEntries.map(({ outputPath, source }) => writeToolSchemaFile(outputPath, source)),
  );

  return metadata;
}

/**
 * 写入 tool zod.js 文件(确保目录存在)
 */
async function writeToolSchemaFile(outputPath: string, source: string): Promise<void> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, source, 'utf-8');
}
