import { createPrograms } from '../ast/createProgram';
import {
  createLazyTypeResolver,
  type HandlerTypeInfo,
  type LazyTypeResolver,
} from '../ast/extractHandlerTypes';
import { getInputTypeForMethod, hasBody } from '../runtime/inputType';
import { getSchemaName } from '../validator/schemaName';
import { analyzeInjectionInSourceFile } from '../injection/analyzeInjection';
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
 * 2. 批量共享 Program（同一次提取只按文件组创建少量 Program）
 * 3. 对每个路由用 analyzeInjectionInSourceFile 定位入口参数类型，
 *    extractTypeInfo 解析入口类型（入口类型必须严格解析，失败抛 SchemaExtractionError）
 * 4. 返回按文件分组的惰性类型解析器——generateSchemaFiles 生成 zod.js 时
 *    遇到 ref（同文件循环引用）按需解析并缓存
 *
 * 惰性语义：与路由无关的类型（未被任何入口类型引用）不会被解析——文件里
 * 存在一个含不支持语法的无关类型不再拖垮整个 build/reload。
 */
export function collectRouteSchemaSources(
  routes: RouteManifest,
  rootDir?: string,
): {
  sources: RouteSchemaSource[];
  /** 按文件分组的惰性类型解析器（generateSchemaFiles 解析 ref 用） */
  resolversByFile: Map<string, LazyTypeResolver>;
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

  // 批量共享 Program：同一次提取只创建一个 Program，避免逐文件全量解析
  const programByFile = createPrograms([...methodsByFile.keys()]);

  // 每个文件一个惰性解析器：入口类型立即解析，ref 按需解析（缓存幂等）
  const resolversByFile = new Map<string, LazyTypeResolver>();
  for (const filePath of methodsByFile.keys()) {
    resolversByFile.set(filePath, createLazyTypeResolver(programByFile.get(filePath)!, filePath));
  }

  // 每个文件提取 schema（key 用 urlPath）
  const sources: RouteSchemaSource[] = [];
  for (const [filePath, entry] of methodsByFile) {
    const program = programByFile.get(filePath)!;
    const sourceFile = program.getSourceFile(filePath);
    if (!sourceFile) continue;
    const resolver = resolversByFile.get(filePath)!;
    for (const method of entry.methods) {
      const inputType = getInputTypeForMethod(method);
      const schemaName = getSchemaName(method, inputType);
      // 复用 program 已解析的 SourceFile，逐方法零重复 parse
      const meta = analyzeInjectionInSourceFile(sourceFile, method);
      // POST/PUT/PATCH（inputType='body'）：优先找 body 参数，找不到再找 form 参数。
      // form 与 body 共享 schema 名（POSTBody），运行时 validateInput 仍按 POSTBodySchema 查找；
      // 差异仅在校验：form 声明时通过 source.coerce=true 显式覆盖（form 值均为 string，
      // 需 z.preprocess 转换 number/boolean 字段）。
      const param =
        meta.params.find((p) => p.type === inputType) ??
        (inputType === 'body' ? meta.params.find((p) => p.type === 'form') : undefined);
      const isForm = param?.type === 'form';
      // 入口类型：必须严格解析（失败抛 SchemaExtractionError，带文件/类型上下文）
      const typeInfo = param?.typeName ? resolver.resolve(param.typeName) : null;
      sources.push({
        urlPath: entry.urlPath,
        filePath,
        schemaName,
        typeInfo,
        coerce: isForm || undefined,
      });

      // params 形参：handler 声明了 `params: XxxParams` 时为每个方法生成
      // <METHOD>Params schema（GETParams / POSTParams / ...），运行时据此校验
      // 路径参数并把 coerce 后的值回写 ctx.params。路径段来源均为 string，
      // coerce 由命名后缀正则推断（Params → true）。未声明则不生成 schema，
      // 运行时跳过校验，ctx.params 保持原始字符串（与未声明行为一致）。
      const paramsArg = meta.params.find((p) => p.type === 'params');
      if (paramsArg?.typeName) {
        sources.push({
          urlPath: entry.urlPath,
          filePath,
          schemaName: getSchemaName(method, 'params'),
          typeInfo: resolver.resolve(paramsArg.typeName) ?? null,
        });
      }

      // 次输入 schema：方法主输入之外显式声明的输入同样「声明即校验」。
      // - body 方法（POST/PUT/PATCH）声明 query 形参 → <METHOD>Query（如 POSTQuery，
      //   Query 后缀自动 coerce），运行时校验 query 并挂载 __validatedQuery
      // - query 主输入且 hasBody 的方法（DELETE）声明 body/form 形参 → <METHOD>Body
      //   （如 DELETEBody），form 与 body 共享 schema 名、coerce=true 显式覆盖
      // - GET/HEAD 声明 body 不收集（hasBody=false，运行时 body 注入恒为 undefined，
      //   该声明属无效标注，保持既往行为）
      if (inputType === 'body') {
        const queryArg = meta.params.find((p) => p.type === 'query');
        if (queryArg?.typeName) {
          sources.push({
            urlPath: entry.urlPath,
            filePath,
            schemaName: getSchemaName(method, 'query'),
            typeInfo: resolver.resolve(queryArg.typeName) ?? null,
          });
        }
      } else if (hasBody(method)) {
        const bodyArg =
          meta.params.find((p) => p.type === 'body') ?? meta.params.find((p) => p.type === 'form');
        if (bodyArg?.typeName) {
          sources.push({
            urlPath: entry.urlPath,
            filePath,
            schemaName: getSchemaName(method, 'body'),
            typeInfo: resolver.resolve(bodyArg.typeName) ?? null,
            coerce: bodyArg.type === 'form' || undefined,
          });
        }
      }
    }
  }

  return { sources, resolversByFile };
}
