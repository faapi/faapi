import { createProgram } from '../ast/createProgram';
import { extractTypeInfo, extractAllTypes, type HandlerTypeInfo } from '../ast/extractHandlerTypes';
import { getInputTypeForMethod } from '../runtime/inputType';
import { getSchemaName } from '../validator/schemaName';
import { analyzeInjection } from '../injection/analyzeInjection';
import type { RouteManifest } from '../router/routeTypes';
import path from 'node:path';

/**
 * 单个路由的 schema 提取结果
 *
 * key 使用 urlPath（如 '/api/hello'）而非 filePath，因为 urlPath 在 dev/prod 完全一致，
 * 无需 remapManifestKeys 桥接 .ts/.js 路径差异。
 */
export interface RouteSchemaSource {
  /** 路由 URL 路径（如 '/api/hello'），作为 schema key */
  urlPath: string;
  /** 源文件绝对路径（用于 generateSchemaFiles 按文件分组生成 zod.js） */
  filePath: string;
  schemaName: string;
  typeInfo: HandlerTypeInfo | null;
  /**
   * 是否对 number/boolean 字段生成 z.preprocess 字符串转换（coerce）。
   *
   * - query/params：始终 coerce=true（URL 来源均为 string）
   * - body：始终 coerce=false（JSON 解析已是天然 JS 类型）
   * - form：coerce=true（form-urlencoded 来源均为 string），由本函数在提取时
   *   检测到 handler 声明 `form` 参数时显式设置。schema 名仍为 `POSTBody`
   *   （与 body 共享运行时 schema key），运行时 validateInput 无需感知 form/body 差异。
   *
   * 未设置时由 generateSchemaFileSource 回退到 schemaName 后缀正则推断（Query/Params → true）。
   */
  coerce?: boolean;
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
 * - dev：生成 JS 模块文件 → import 加载（用 allTypesByFile）
 * - prd：生成 JS 模块代码 → SchemaModuleEntry[]（用 allTypesByFile）
 */
export function collectRouteSchemaSources(
  routes: RouteManifest,
  rootDir?: string,
): {
  sources: RouteSchemaSource[];
  /** 按文件分组的类型映射（prd writeSchemaModule 用） */
  allTypesByFile: Map<string, Map<string, HandlerTypeInfo>>;
  /** 合并后的全局类型映射（兼容旧调用方保留，新路径使用 allTypesByFile） */
  mergedAllTypes: Map<string, HandlerTypeInfo>;
} {
  // 按文件分组收集方法（去重）
  // key 是文件绝对路径（createProgram 需要），但 schema key 用 urlPath
  const methodsByFile = new Map<string, { urlPath: string; methods: Set<string> }>();
  for (const route of routes) {
    const filePath = rootDir ? path.resolve(rootDir, route.filePath) : route.filePath;
    let entry = methodsByFile.get(filePath);
    if (!entry) {
      entry = { urlPath: route.urlPath, methods: new Set() };
      methodsByFile.set(filePath, entry);
    }
    entry.methods.add(route.method);
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

  // 每个文件提取 schema（key 用 urlPath）
  const sources: RouteSchemaSource[] = [];
  for (const [filePath, entry] of methodsByFile) {
    const program = programByFile.get(filePath)!;
    const sourceFile = program.getSourceFile(filePath);
    const code = sourceFile?.text ?? '';
    for (const method of entry.methods) {
      const inputType = getInputTypeForMethod(method);
      const schemaName = getSchemaName(method, inputType);
      const meta = analyzeInjection(code, method);
      // POST/PUT/PATCH（inputType='body'）：优先找 body 参数，找不到再找 form 参数。
      // form 与 body 共享 schema 名（POSTBody），运行时 validateInput 仍按 POSTBodySchema 查找；
      // 差异仅在校验：form 声明时通过 source.coerce=true 显式覆盖（form 值均为 string，
      // 需 z.preprocess 转换 number/boolean 字段）。
      const param =
        meta.params.find((p) => p.type === inputType) ??
        (inputType === 'body' ? meta.params.find((p) => p.type === 'form') : undefined);
      const isForm = param?.type === 'form';
      const typeInfo = param?.typeName ? extractTypeInfo(program, filePath, param.typeName) : null;
      sources.push({
        urlPath: entry.urlPath,
        filePath,
        schemaName,
        typeInfo,
        coerce: isForm || undefined,
      });
    }
  }

  return { sources, allTypesByFile, mergedAllTypes };
}
