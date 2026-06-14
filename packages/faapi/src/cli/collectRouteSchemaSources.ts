import { createProgram } from '../ast/createProgram';
import { extractTypeInfo, extractAllTypes, type HandlerTypeInfo } from '../ast/extractHandlerTypes';
import { getInputTypeForMethod } from '../runtime/inputType';
import { getSchemaName } from '../validator/schemaName';
import { analyzeInjection } from '../injection/analyzeInjection';
import type { RouteManifest } from '../router/routeTypes';
import path from 'node:path';

/**
 * 单个路由的 schema 提取结果
 */
export interface RouteSchemaSource {
  filePath: string;
  schemaName: string;
  typeInfo: HandlerTypeInfo | null;
}

/**
 * 从路由清单收集 schema 提取所需的原始数据
 *
 * dev 和 prd 共享的核心提取流程：
 * 1. 按文件分组遍历路由
 * 2. 对每个文件 createProgram + extractAllTypes 收集所有类型
 * 3. 用 analyzeInjection + extractTypeInfo 提取每个路由的 schema 类型
 * 4. 同时返回按文件分组的 allTypesMap 和合并后的全局 allTypes
 *
 * 调用方基于返回的 sources 和 allTypes 各自做最终转换：
 * - dev：编译 validator 函数 → SchemaManifest（用 mergedAllTypes）
 * - prd：生成 JS 模块代码 → SchemaModuleEntry[]（用 allTypesByFile）
 */
export function collectRouteSchemaSources(
  routes: RouteManifest,
  rootDir?: string,
): {
  sources: RouteSchemaSource[];
  /** 按文件分组的类型映射（prd writeSchemaModule 用） */
  allTypesByFile: Map<string, Map<string, HandlerTypeInfo>>;
  /** 合并后的全局类型映射（dev typeInfoToSchemaEntry 用） */
  mergedAllTypes: Map<string, HandlerTypeInfo>;
} {
  // 按文件分组收集方法（去重）
  const methodsByFile = new Map<string, Set<string>>();
  for (const route of routes) {
    const filePath = rootDir ? path.resolve(rootDir, route.filePath) : route.filePath;
    let methods = methodsByFile.get(filePath);
    if (!methods) {
      methods = new Set();
      methodsByFile.set(filePath, methods);
    }
    methods.add(route.method);
  }

  // 先收集所有文件的类型
  const programByFile = new Map<string, ReturnType<typeof createProgram>>();
  const allTypesByFile = new Map<string, Map<string, HandlerTypeInfo>>();
  const mergedAllTypes = new Map<string, HandlerTypeInfo>();
  for (const filePath of methodsByFile.keys()) {
    const program = createProgram(filePath);
    programByFile.set(filePath, program);
    const allTypes = extractAllTypes(program, filePath);
    allTypesByFile.set(filePath, allTypes);
    for (const [name, info] of allTypes) {
      mergedAllTypes.set(name, info);
    }
  }

  // 每个文件提取 schema
  const sources: RouteSchemaSource[] = [];
  for (const [filePath, methods] of methodsByFile) {
    const program = programByFile.get(filePath)!;
    const sourceFile = program.getSourceFile(filePath);
    const code = sourceFile?.text ?? '';
    for (const method of methods) {
      const inputType = getInputTypeForMethod(method);
      const schemaName = getSchemaName(method, inputType);
      const meta = analyzeInjection(code, method);
      const param = meta.params.find((p) => p.type === inputType);
      const typeInfo = param?.typeName ? extractTypeInfo(program, filePath, param.typeName) : null;
      sources.push({ filePath, schemaName, typeInfo });
    }
  }

  return { sources, allTypesByFile, mergedAllTypes };
}
