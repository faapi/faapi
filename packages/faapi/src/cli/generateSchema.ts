import {
  generateValidatorSource,
  generateSchemaModule,
  type SchemaModuleEntry,
} from '../ast/generateValidatorCode';
import type { HandlerTypeInfo } from '../ast/extractHandlerTypes';
import type { RouteManifest } from '../router/routeTypes';
import type { SchemaManifest, SchemaEntry } from '../validator/schemaRegistry';
import { collectRouteSchemaSources } from './collectRouteSchemaSources';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * 从路由清单提取完整 manifest，并生成校验函数
 *
 * 同一文件的多个方法合并到同一 FileSchemas。
 *
 * 与 prd 的 writeSchemaModule 一致：先收集所有文件的类型并合并为全局 allTypes，
 * 再传给每个文件的 schema 生成，确保跨文件类型引用可解析（与 prd 行为一致）。
 *
 * @param routes 路由清单（filePath 为相对路径）
 * @param rootDir 项目根目录，传入时将 filePath 转为绝对路径（与 validateInput 调用一致）
 */
export function extractSchemasForRoutes(routes: RouteManifest, rootDir?: string): SchemaManifest {
  const { sources, mergedAllTypes } = collectRouteSchemaSources(routes, rootDir);

  // 按文件分组，合并为 FileSchemas
  const manifest: SchemaManifest = new Map();
  for (const { filePath, schemaName, typeInfo } of sources) {
    let fileSchemas = manifest.get(filePath);
    if (!fileSchemas) {
      fileSchemas = new Map();
      manifest.set(filePath, fileSchemas);
    }
    fileSchemas.set(schemaName, typeInfoToSchemaEntry(typeInfo, mergedAllTypes));
  }

  return manifest;
}

/**
 * 将 HandlerTypeInfo 转为 SchemaEntry（包含 properties 和 validator）
 *
 * typeInfo 为 null 时返回 null（跳过校验）。
 * typeInfo 非 null 时生成校验函数源码并用 new Function 创建。
 */
function typeInfoToSchemaEntry(
  typeInfo: HandlerTypeInfo | null,
  allTypes: Map<string, HandlerTypeInfo>,
): SchemaEntry {
  if (typeInfo === null) return null;

  const source = generateValidatorSource(typeInfo, (name) => allTypes.get(name)?.runtimeType);
  // 用 new Function 创建校验函数
  const validator = new Function('input', `${source}\nreturn validate(input);`) as (
    input: unknown,
  ) => ReturnType<typeof Object>;
  return {
    properties: typeInfo.properties,
    validator: validator as SchemaEntry extends { validator: infer F } ? F : never,
  };
}

/**
 * 生成 schema JS 模块并写入文件
 *
 * @param entries schema 模块条目（包含 typeInfo）
 * @param allTypesMap 每个文件对应的所有类型（用于解析循环引用）
 * @param outputPath 输出路径（如 dist/faapi-schema.js）
 */
export async function writeSchemaModule(
  entries: SchemaModuleEntry[],
  allTypesMap: Map<string, Map<string, HandlerTypeInfo>>,
  outputPath: string,
): Promise<void> {
  // 合并所有文件的类型解析器
  const allTypes = new Map<string, HandlerTypeInfo>();
  for (const types of allTypesMap.values()) {
    for (const [name, info] of types) {
      allTypes.set(name, info);
    }
  }

  const source = generateSchemaModule(entries, (name) => allTypes.get(name)?.runtimeType);

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, source, 'utf-8');
}

/**
 * 读取 schema JS 模块并转为 SchemaManifest
 *
 * 动态 import JS 模块，获取 validators 和 properties 对象。
 */
export async function readManifestFile(inputPath: string): Promise<SchemaManifest> {
  const fileUrl = `file://${inputPath}`;
  const mod = await import(fileUrl);
  const validators = mod.validators as Record<string, ((input: unknown) => unknown) | null>;
  const properties = (mod.properties ?? {}) as Record<string, unknown[]>;

  const manifest: SchemaManifest = new Map();
  for (const [key, validator] of Object.entries(validators)) {
    const [filePath, schemaName] = key.split('#');
    if (!filePath || !schemaName) continue;

    let fileSchemas = manifest.get(filePath);
    if (!fileSchemas) {
      fileSchemas = new Map();
      manifest.set(filePath, fileSchemas);
    }

    if (validator === null) {
      fileSchemas.set(schemaName, null);
    } else {
      fileSchemas.set(schemaName, {
        properties: (properties[key] ?? []) as SchemaEntry extends { properties: infer P }
          ? P
          : never,
        validator: validator as SchemaEntry extends { validator: infer F } ? F : never,
      });
    }
  }

  return manifest;
}
