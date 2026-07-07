import path from 'node:path';
import fs from 'node:fs/promises';
import type { RouteManifest } from '../router/routeTypes';
import type { RouteSchemaSource } from './collectRouteSchemaSources';
import type { HandlerTypeInfo } from '../ast/extractHandlerTypes';
import { collectRouteSchemaSources } from './collectRouteSchemaSources';
import {
  generateZodSchemaSource,
  generateHelpersFileSource,
  usesCoerceHelpers,
  HELPERS_FILENAME,
} from '../ast/generateZodSchema';

/**
 * 源文件路径 → 产物 zod.js 路径
 *
 * 每个 handler 目录下生成一个 `zod.js`（与 handler.js 同级，文件名固定为 zod.js）：
 * - `src/api/hello/handler.ts` → `<dist>/api/hello/zod.js`
 *
 * 路由源码目录写死为 src，剥离 `src/` 前缀。
 *
 * @param sourceFile 源文件相对路径（相对 rootDir，如 'src/api/hello/handler.ts'）
 * @param dist 输出目录（如 'dist' 或 '.faapi'）
 * @param rootDir 项目根目录
 */
export function getSchemaOutputPath(sourceFile: string, dist: string, rootDir: string): string {
  let rel = sourceFile.replace(/\\/g, '/');
  // 去掉 src/ 前缀（打平产物结构）
  if (rel.startsWith('src/')) {
    rel = rel.slice(4);
  }
  // 取目录部分，basename 固定为 zod.js（每个 handler 目录一个 zod.js）
  const idx = rel.lastIndexOf('/');
  const relDir = idx >= 0 ? rel.slice(0, idx) : '';
  return path.resolve(rootDir, dist, relDir, 'zod.js');
}

/**
 * 运行时从 route.filePath 计算对应 zod.js 绝对路径
 *
 * 每个 handler 目录下的 zod.js（文件名固定为 zod.js，与 handler.js 同级）：
 * - dev 模式：route.filePath 是源码路径（如 'src/api/hello/handler.ts'），
 *   zod.js 在 `<rootDir>/<dist>/api/hello/zod.js`
 * - prod 模式：route.filePath 是产物路径（如 'dist/api/hello/handler.js'），
 *   zod.js 在 `<rootDir>/dist/api/hello/zod.js`（与 handler.js 同级）
 *
 * 通过同时检查 src 和 dist 前缀，统一处理两种模式：
 * - dev：strip 'src/' 前缀，join dist
 * - prod：strip 'dist/' 前缀，join dist（dist='dist'，结果与 rootDir 一致）
 *
 * @param filePath route.filePath（dev 为源码路径，prod 为产物路径）
 * @param dist 输出目录（如 'dist' 或 '.faapi'）
 * @param rootDir 项目根目录
 */
export function getRuntimeSchemaPath(filePath: string, dist: string, rootDir: string): string {
  let rel = filePath.replace(/\\/g, '/');
  // strip src/ 前缀（dev 模式：filePath = 'src/...'）
  if (rel.startsWith('src/')) {
    rel = rel.slice(4);
  }
  // strip dist 前缀（prod 模式：filePath = 'dist/...'）
  else if (rel.startsWith(`${dist}/`)) {
    rel = rel.slice(dist.length + 1);
  }
  // 取目录部分，basename 固定为 zod.js
  const idx = rel.lastIndexOf('/');
  const relDir = idx >= 0 ? rel.slice(0, idx) : '';
  return path.resolve(rootDir, dist, relDir, 'zod.js');
}

/**
 * 计算 zod.js 到 faapi-helpers.js 的相对 import 路径
 *
 * faapi-helpers.js 固定在 dist 根部，zod.js 可能在子目录（如 'api/hello/zod.js'）。
 * 根据子目录深度计算 `../` 数量：
 * - zod.js 在 `api/hello/`（深度 2）→ `../../faapi-helpers.js`
 * - zod.js 在 `api/`（深度 1）→ `../faapi-helpers.js`
 * - zod.js 在 dist 根（深度 0，理论不会发生）→ `./faapi-helpers.js`
 *
 * @param relDir zod.js 所在目录相对 dist 的路径（如 'api/hello' 或 ''）
 * @returns ESM import 路径（如 '../../faapi-helpers.js'）
 */
export function getHelpersImportPath(relDir: string): string {
  if (!relDir) return `./${HELPERS_FILENAME}`;
  const depth = relDir.split('/').filter(Boolean).length;
  return `${'../'.repeat(depth)}${HELPERS_FILENAME}`;
}

/**
 * 生成单个 handler 文件的 zod.js 源码
 *
 * 自包含：extractAllTypes 在 AST 阶段已通过 TypeScript checker 内联跨文件类型，
 * 每个 zod.js 无需 import 其他 zod.js。ref 仅用于同文件内的循环引用（通过 z.lazy 处理）。
 *
 * 导出格式：
 * - `<SchemaName>Schema`：zod schema 对象（用于 safeParse 校验）
 *
 * 无类型声明的方法不导出对应 Schema（validateInput 检测到 undefined 跳过校验）。
 *
 * coerce 逻辑：query/params 来源均为 string，schemaName 以 "Query" 或 "Params" 结尾时
 * 生成 coerce=true 的 schema（number/boolean 字段用 z.preprocess 包裹字符串转换）。
 * body 是 JSON 解析的天然 JS 类型，不需要 coerce。form 与 body 共享 schema 名（POSTBody），
 * 但 `RouteSchemaSource.coerce=true` 显式覆盖（form 值均为 string，需 coerce）。
 * Map/Set 字段在两种场景下都生成 z.preprocess 包裹（JSON.parse 出来的是数组/对象，需还原为 Map/Set 实例）。
 *
 * 公用函数复用：schema 引用 coerceNumber / coerceBoolean / coerceMap / coerceSet 变量时，
 * 这些变量从 dist 根部的 faapi-helpers.js import（跨文件复用，仅一份声明）。
 *
 * @param sources 同一文件的 schema 提取结果（含多个方法，如 GETQuery + POSTBody）
 * @param allTypes 该文件的所有命名类型（用于解析循环引用中的 ref）
 * @param helpersImportPath 到 faapi-helpers.js 的相对 import 路径（如 '../../faapi-helpers.js'）。
 *        传空字符串表示不注入 coerce helpers 的 import（用于无 coerce schema 的文件或不支持外部 import 的测试场景）。
 * @returns zod.js 源码字符串
 */
export function generateSchemaFileSource(
  sources: RouteSchemaSource[],
  allTypes: Map<string, HandlerTypeInfo>,
  helpersImportPath: string,
): string {
  const resolveType = (name: string) => allTypes.get(name)?.runtimeType;
  const lines: string[] = ["import { z } from 'zod';"];

  // 先生成所有 schema 代码，暂存到 schemaBlocks
  const schemaBlocks: string[] = [];
  for (const source of sources) {
    const { schemaName, typeInfo } = source;
    if (!typeInfo) {
      // 无类型声明，不导出对应 Schema
      continue;
    }

    // 推断 coerce：
    // - source.coerce 显式设置时优先使用（form 声明时由 collectRouteSchemaSources 设置为 true）
    // - 否则回退到 schemaName 后缀正则：query/params 需要 coerce（URL 来源均为 string），body 不需要
    const coerce = source.coerce ?? /(?:Query|Params)$/.test(schemaName);

    const block = [`// ${schemaName}`];
    // generateZodSchemaSource 自带 import 语句，剥离后由本函数统一管理 import
    // 传入 schemaName 作为 exportName，确保导出名与 validateInput 查找的一致
    const schemaCode = generateZodSchemaSource(typeInfo, resolveType, schemaName, coerce).replace(
      /^import \{ z \} from 'zod';\s*\n\s*\n/,
      '',
    );
    block.push(schemaCode);
    block.push('');
    schemaBlocks.push(block.join('\n'));
  }

  // 检测是否有 schema 引用了 coerce 公用函数，若有则注入 import 语句
  // 公用函数包含 coerceNumber / coerceBoolean（query/params 的 string 转换）和
  // coerceMap / coerceSet（Map/Set 的 JSON 还原，body 场景也会引用）
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
 * 为路由清单中每个 handler 生成 zod.js
 *
 * 输出路径与 handler.js 同级（文件名固定为 zod.js）：
 * - dev：`.faapi/api/hello/zod.js`
 * - prod：`dist/api/hello/zod.js`
 *
 * 公用函数复用：若项目中存在 coerce schema（query/params）或 Map/Set 字段，
 * 在 dist 根部生成 `faapi-helpers.js`（导出 coerceNumber / coerceBoolean / coerceMap / coerceSet），
 * 各 zod.js 通过相对路径 import。
 *
 * 内部流程：
 * 1. collectRouteSchemaSources 从路由清单提取 schema 源数据（AST 从源码 .ts）
 * 2. 按 filePath 分组 sources
 * 3. 为每个文件生成 zod.js 源码（暂存，用于检测是否需要 helpers）
 * 4. 检测是否需要 helpers，需要则生成 faapi-helpers.js
 * 5. 并行写入所有 zod.js
 *
 * @param routes 排序后的路由清单
 * @param rootDir 项目根目录
 * @param dist 输出目录（如 '.faapi' 或 'dist'）
 */
export async function generateSchemaFiles(
  routes: RouteManifest,
  rootDir: string,
  dist: string,
): Promise<void> {
  if (routes.length === 0) return;

  const { sources, allTypesByFile } = collectRouteSchemaSources(routes, rootDir);

  // 按 filePath 分组 sources（同一 handler 的多个方法合并到一个 zod.js）
  const sourcesByFile = new Map<string, RouteSchemaSource[]>();
  for (const source of sources) {
    let list = sourcesByFile.get(source.filePath);
    if (!list) {
      list = [];
      sourcesByFile.set(source.filePath, list);
    }
    list.push(source);
  }

  // 为每个文件生成 zod.js 源码（先暂存，用于检测是否需要 helpers）
  const fileEntries: { outputPath: string; source: string }[] = [];
  for (const [filePath, fileSources] of sourcesByFile) {
    // filePath 是绝对路径，转为相对 rootDir 的路径用于计算输出路径
    const relFile = path.relative(rootDir, filePath).replace(/\\/g, '/');
    const outputPath = getSchemaOutputPath(relFile, dist, rootDir);
    const allTypes = allTypesByFile.get(filePath) ?? new Map();

    // 计算 zod.js 所在目录相对 dist 的路径（用于 import helpers）
    // 与 getSchemaOutputPath 的目录计算逻辑一致：strip src/ 前缀后取目录部分
    let relForDir = relFile;
    if (relForDir.startsWith('src/')) {
      relForDir = relForDir.slice(4);
    }
    const dirIdx = relForDir.lastIndexOf('/');
    const zodRelDir = dirIdx >= 0 ? relForDir.slice(0, dirIdx) : '';
    const helpersImportPath = getHelpersImportPath(zodRelDir);

    const source = generateSchemaFileSource(fileSources, allTypes, helpersImportPath);
    fileEntries.push({ outputPath, source });
  }

  // 检测是否需要生成 faapi-helpers.js
  const allSourceCode = fileEntries.map((e) => e.source).join('\n');
  if (usesCoerceHelpers(allSourceCode)) {
    const helpersPath = path.resolve(rootDir, dist, HELPERS_FILENAME);
    await writeSchemaFile(helpersPath, generateHelpersFileSource());
  }

  // 并行写入所有 zod.js
  await Promise.all(
    fileEntries.map(({ outputPath, source }) => writeSchemaFile(outputPath, source)),
  );
}

/**
 * 写入 zod.js 文件（确保目录存在）
 */
async function writeSchemaFile(outputPath: string, source: string): Promise<void> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, source, 'utf-8');
}
