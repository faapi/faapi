import ts from 'typescript';
import {
  resolveTypeNode,
  resolveInterfaceDeclaration,
  resolveEnumDeclaration,
  findTopLevelDecl,
  setProgramContext,
  mergeObjectMember,
  type PropertyType,
  type RuntimeType,
  SchemaExtractionError,
} from './resolveTypeNode';
import {
  hasFrameworkMember,
  collectNonFrameworkCtxMembers,
  findExportedFunction,
} from './extractToolMetadata';

export interface HandlerTypeInfo {
  name: string; // 类型名，如 'GETQuery'
  properties: PropertyType[];
  /** 完整的运行时类型描述（用于嵌套校验） */
  runtimeType: RuntimeType;
}

/**
 * 从源文件中提取指定名称的类型信息
 *
 * 支持的类型声明：
 * - interface 声明（含继承）
 * - type 别名（type Query = { ... }）
 * - enum 声明（跨文件回退路径支持）
 *
 * 自身文件找不到目标声明时，回退到 program 的其他源文件查找同名顶层声明
 * （跳过 node_modules / TypeScript lib，首个匹配生效，与 resolveImportAlias
 * 兜底路径语义一致）。该回退服务于入口类型中第二次出现的跨文件引用：首次引用
 * 已由 checker 内联，二次引用被标记为 ref，代码生成阶段经
 * createLazyTypeResolver → extractTypeInfo 解析，若无回退会静默生成
 * z.unknown()，违背「不降级放行」约定。
 *
 * 遇到不支持的类型时抛 `SchemaExtractionError`，错误信息包含文件路径和类型名。
 *
 * @param program TypeScript Program
 * @param filePath 源文件路径
 * @param typeName 类型名，如 'GETQuery'
 */
export function extractTypeInfo(
  program: ts.Program,
  filePath: string,
  typeName: string,
): HandlerTypeInfo | null {
  const sourceFile = program.getSourceFile(filePath);
  if (!sourceFile) return null;

  const checker = program.getTypeChecker();

  // 设置 program 上下文,供 resolveImportAlias 兜底遍历跨文件声明使用
  // (TypeChecker 运行时未暴露 getProgram(),通过模块级变量传入)
  setProgramContext(program);
  try {
    // 1. 查找 interface 声明
    let result: HandlerTypeInfo | null = null;

    ts.forEachChild(sourceFile, (node) => {
      if (result) return;

      if (ts.isInterfaceDeclaration(node) && node.name.text === typeName) {
        const visited = new Set<string>();
        visited.add(typeName); // 标记当前类型，使自引用直接返回 ref
        const runtimeType = withFileContext(filePath, typeName, () =>
          resolveInterfaceDeclaration(node, checker, visited),
        );
        result = {
          name: typeName,
          properties: runtimeType.kind === 'object' ? runtimeType.properties : [],
          runtimeType,
        };
        return;
      }

      // 2. 查找 type 别名
      if (ts.isTypeAliasDeclaration(node) && node.name.text === typeName) {
        const visited = new Set<string>();
        visited.add(typeName); // 标记当前类型，使自引用直接返回 ref
        const runtimeType = withFileContext(filePath, typeName, () =>
          resolveTypeNode(node.type, checker, visited),
        );
        result = {
          name: typeName,
          properties: runtimeType.kind === 'object' ? runtimeType.properties : [],
          runtimeType,
        };
        return;
      }
    });

    if (result) return result;

    // 3. 跨文件回退：自身文件无该声明时，在 program 的其他源文件中查找同名顶层声明
    for (const sf of program.getSourceFiles()) {
      if (sf === sourceFile) continue;
      // 与 resolveImportAlias 兜底路径使用相同的过滤规则
      if (sf.fileName.includes('/node_modules/') || sf.fileName.includes('typescript/lib/')) {
        continue;
      }
      const found = findTopLevelDecl(sf, typeName);
      if (!found) continue;

      const visited = new Set<string>();
      visited.add(typeName);
      const runtimeType = withFileContext(filePath, typeName, () => {
        if (found.kind === 'interface') {
          return resolveInterfaceDeclaration(found.node, checker, visited);
        }
        if (found.kind === 'typeAlias') {
          return resolveTypeNode(found.node.type, checker, visited);
        }
        return resolveEnumDeclaration(found.node);
      });
      return {
        name: typeName,
        properties: runtimeType.kind === 'object' ? runtimeType.properties : [],
        runtimeType,
      };
    }

    return null;
  } finally {
    setProgramContext(null);
  }
}

/**
 * tool ctx 校验类型的解析（三段式：剥离解析 → 声明原路径 → 内联回退）
 *
 * - **剥离解析**：ctxTypeName 为**别名名**且声明体为含框架侧成员的交叉（默认名形态：
 *   `type Combined = A & B & AgentToolContext`，由 getCtxSchemaTypeName 解引用决定）时，
 *   普通 extractTypeInfo 解析别名整体会撞上 `AgentToolContext` 的
 *   `import('...').TaskClient` 类型语法——跳过 `AgentToolContext` 成员，逐成员经
 *   resolveTypeNode 解析（TypeReference 与内联字面量均可），按交叉合并语义
 *   （mergeObjectMember）合并为单 object——非 object 成员 / 同名字段冲突显式抛错
 * - **声明原路径**：存在同名顶层声明（非剥离形态）→ extractTypeInfo 原路径，
 *   行为不变（普通业务类型名、无框架侧成员的别名、interface 均同；
 *   interface extends AgentToolContext 不剥离，原路径显式抛错）
 * - **内联回退**：无同名声明且提供 `functionName`（纯内联标注/内联交叉的合成默认名
 *   `${函数名}Ctx` 形态——同名声明已在 getCtxSchemaTypeName 合成时排除）→ 从源码
 *   第二参标注直接解析（resolveInlineCtxAnnotation），无可解析字段时回退原路径
 *
 * 声明查找与 extractTypeInfo 同构：本文件顶层优先，跨文件回退跳过
 * node_modules / TypeScript lib，首个匹配生效。
 *
 * @param program TypeScript Program
 * @param filePath handler 源文件路径
 * @param typeName ctx 校验类型名（业务类型名、别名名或合成默认名）
 * @param functionName 源码导出函数名（内联回退定位第二参标注用，可选）
 */
export function extractCtxTypeInfo(
  program: ts.Program,
  filePath: string,
  typeName: string,
  functionName?: string,
): HandlerTypeInfo | null {
  const sourceFile = program.getSourceFile(filePath);
  if (!sourceFile) return null;

  const checker = program.getTypeChecker();
  setProgramContext(program);
  try {
    // 定位同名顶层声明：本文件优先 → 跨文件回退（首个匹配生效，与 extractTypeInfo 同构）
    let found = findTopLevelDecl(sourceFile, typeName);
    let foundFile = sourceFile;
    if (!found) {
      for (const sf of program.getSourceFiles()) {
        if (sf === sourceFile) continue;
        if (sf.fileName.includes('/node_modules/') || sf.fileName.includes('typescript/lib/')) {
          continue;
        }
        found = findTopLevelDecl(sf, typeName);
        if (found) {
          foundFile = sf;
          break;
        }
      }
    }

    if (
      found?.kind === 'typeAlias' &&
      ts.isIntersectionTypeNode(found.node.type) &&
      hasFrameworkMember(found.node.type, foundFile)
    ) {
      const typeNode = found.node.type;
      const visited = new Set<string>();
      visited.add(typeName); // 标记当前类型，使自引用直接返回 ref
      const properties = withFileContext(filePath, typeName, () =>
        resolveCtxMemberProperties(
          collectNonFrameworkCtxMembers(typeNode, foundFile),
          checker,
          visited,
          typeNode,
          foundFile,
        ),
      );
      return {
        name: typeName,
        properties,
        runtimeType: { kind: 'object' as const, properties },
      };
    }

    // 存在同名声明（非剥离形态）→ 声明优先，原路径行为不变
    if (found) return extractTypeInfo(program, filePath, typeName);

    // 无同名声明 + functionName → 内联回退（纯内联标注/内联交叉的合成默认名形态）
    if (functionName) {
      const properties = withFileContext(filePath, typeName, () =>
        resolveInlineCtxAnnotation(program, filePath, functionName),
      );
      if (properties) {
        return {
          name: typeName,
          properties,
          runtimeType: { kind: 'object' as const, properties },
        };
      }
    }

    return extractTypeInfo(program, filePath, typeName);
  } finally {
    setProgramContext(null);
  }
}

/**
 * ctx 交叉/字面量成员解析合并（剥离解析与内联回退共用）
 *
 * 逐成员 resolveTypeNode 后按交叉合并语义（mergeObjectMember）合并为单 object
 * 属性列表——非 object 成员 / 同名字段冲突显式抛错（不降级）。
 */
function resolveCtxMemberProperties(
  typeNodes: readonly ts.TypeNode[],
  checker: ts.TypeChecker,
  visited: Set<string>,
  errorNode: ts.Node,
  errorFile: ts.SourceFile,
): PropertyType[] {
  const propMap = new Map<string, PropertyType>();
  for (const member of typeNodes) {
    mergeObjectMember(propMap, resolveTypeNode(member, checker, visited), errorNode, errorFile);
  }
  return [...propMap.values()];
}

/**
 * 内联 ctx 标注回退解析（合成默认名形态：第二参标注无具名声明时从源码直接解析）
 *
 * 定位 handler 导出函数第二参的类型标注：
 * - TypeLiteral（纯内联）→ 整体解析
 * - Intersection → 剥离框架侧成员后合并（与别名剥离解析同构）；
 *   无业务成员 / 唯一具名 TypeReference 成员 → `null`（交回声明路径——
 *   具名成员的声明存在时 extractCtxTypeInfo 已走声明路径，不存在时原路径返回 null）
 * - 其余（关键词类型/联合等，getCtxSchemaTypeName 对其返回 undefined）→ `null`
 *
 * @returns object 属性列表；无可解析的内联业务字段时 `null`
 */
function resolveInlineCtxAnnotation(
  program: ts.Program,
  filePath: string,
  functionName: string,
): PropertyType[] | null {
  const sourceFile = program.getSourceFile(filePath);
  if (!sourceFile) return null;
  const found = findExportedFunction(sourceFile, functionName);
  if (!found) return null;
  const annotation = found.fn.parameters[1]?.type;
  if (!annotation) return null;

  const checker = program.getTypeChecker();

  // 纯内联字面量标注：整体解析
  if (ts.isTypeLiteralNode(annotation)) {
    return resolveCtxMemberProperties([annotation], checker, new Set(), annotation, sourceFile);
  }

  // 内联交叉标注：剥离框架侧成员后合并（与别名剥离解析同构）
  if (ts.isIntersectionTypeNode(annotation)) {
    const members = collectNonFrameworkCtxMembers(annotation, sourceFile);
    if (members.length === 0) return null;
    const first = members[0];
    if (members.length === 1 && (!first || ts.isTypeReferenceNode(first))) return null;
    return resolveCtxMemberProperties(members, checker, new Set(), annotation, sourceFile);
  }

  return null;
}

/**
 * HTTP 路由形参内联标注解析（`query: { page: number }` 写法）
 *
 * 按函数名 + 形参名定位标注节点，与具名引用（`query: Query` → resolver.resolve）
 * 同为「声明即校验」，语义见 collectRouteSchemaSources.md「内联形参标注的收集」：
 *
 * - 标注为 TypeLiteral → resolveTypeNode 整体解析，包装为 HandlerTypeInfo
 *   （name 由调用方传入合成 schema 名，如 `GETQuery`——schema 导出名本就不依赖标注具名）
 * - 其余形态（TypeReference / 交叉 / 联合 / 关键词）→ `null`，由调用方按无 schema 处理
 * - 函数 / 形参不存在 → `null`
 *
 * 合成名冲突 fail-fast：合成 schema 名与文件内已有顶层类型声明同名时抛
 * SchemaExtractionError——同名意味着校验源歧义（形参内联 vs 同名声明），且 zod.js
 * 会出现双重声明；要求改用具名标注或重命名声明（与 tool ctx 的 synthesizeCtxName 同款）。
 *
 * @param program TypeScript Program
 * @param filePath handler 源文件绝对路径
 * @param functionName 导出函数名（如 'GET'）
 * @param paramName 形参名（如 'query'）
 * @param name 合成 schema 名（HandlerTypeInfo.name，如 'GETQuery'）
 */
export function extractInlineParamTypeInfo(
  program: ts.Program,
  filePath: string,
  functionName: string,
  paramName: string,
  name: string,
): HandlerTypeInfo | null {
  const sourceFile = program.getSourceFile(filePath);
  if (!sourceFile) return null;
  const found = findExportedFunction(sourceFile, functionName);
  if (!found) return null;
  const annotation = found.fn.parameters.find(
    (p) => p.name.getText(sourceFile) === paramName,
  )?.type;
  if (!annotation || !ts.isTypeLiteralNode(annotation)) return null;

  // 合成名与文件内已有顶层类型声明同名 → 校验源歧义 + zod.js 双重声明，fail-fast
  if (findTopLevelDecl(sourceFile, name)) {
    throw SchemaExtractionError.at(
      annotation,
      name,
      `路由形参内联标注的合成 schema 名 "${name}" 与文件内已有类型声明同名，` +
        `校验源歧义（内联标注 vs 同名声明）且 zod.js 会出现双重声明。` +
        `请改用具名标注（如 ${paramName}: ${name}），或重命名冲突声明`,
      sourceFile,
    );
  }

  setProgramContext(program);
  try {
    const runtimeType = withFileContext(filePath, name, () =>
      resolveTypeNode(annotation, program.getTypeChecker(), new Set()),
    );
    return {
      name,
      properties: runtimeType.kind === 'object' ? runtimeType.properties : [],
      runtimeType,
    };
  } finally {
    setProgramContext(null);
  }
}

/**
 * 从源文件中提取所有 interface 和 type 别名的类型信息
 *
 * 用于：
 * - 生成 schema 模块时遍历所有命名类型
 * - 作为 typeResolver 提供给 generateZodSchema，解析循环引用中的 ref
 *
 * @returns Map<类型名, HandlerTypeInfo>
 */
export function extractAllTypes(
  program: ts.Program,
  filePath: string,
): Map<string, HandlerTypeInfo> {
  const sourceFile = program.getSourceFile(filePath);
  if (!sourceFile) return new Map();

  const checker = program.getTypeChecker();

  // 设置 program 上下文,供 resolveImportAlias 兜底遍历跨文件声明使用
  setProgramContext(program);
  try {
    const result = new Map<string, HandlerTypeInfo>();

    ts.forEachChild(sourceFile, (node) => {
      if (ts.isInterfaceDeclaration(node)) {
        const visited = new Set<string>();
        visited.add(node.name.text); // 标记当前类型，使自引用直接返回 ref
        const runtimeType = withFileContext(filePath, node.name.text, () =>
          resolveInterfaceDeclaration(node, checker, visited),
        );
        result.set(node.name.text, {
          name: node.name.text,
          properties: runtimeType.kind === 'object' ? runtimeType.properties : [],
          runtimeType,
        });
        return;
      }

      if (ts.isTypeAliasDeclaration(node)) {
        const visited = new Set<string>();
        visited.add(node.name.text); // 标记当前类型，使自引用直接返回 ref
        const runtimeType = withFileContext(filePath, node.name.text, () =>
          resolveTypeNode(node.type, checker, visited),
        );
        result.set(node.name.text, {
          name: node.name.text,
          properties: runtimeType.kind === 'object' ? runtimeType.properties : [],
          runtimeType,
        });
        return;
      }
    });

    return result;
  } finally {
    setProgramContext(null);
  }
}

/**
 * 惰性类型解析器
 *
 * 按名称解析类型并缓存。与 extractAllTypes 的差异：extractAllTypes 提前解析
 * 文件中全部顶层类型——与路由无关的类型也会被解析，其中任何类型含不支持语法
 * 都会拖垮整个 build/reload；惰性解析器只在类型真正被需要时（入口类型或
 * ref 引用）才解析，无关类型零开销。
 */
export interface LazyTypeResolver {
  /**
   * 按名称解析类型
   *
   * @returns 类型信息；文件中无该名称的声明时返回 null
   * @throws SchemaExtractionError 类型声明含不支持语法时（与 extractTypeInfo 一致，不降级）
   */
  resolve(name: string): HandlerTypeInfo | null;
}

/**
 * 创建文件的惰性类型解析器
 *
 * 缓存保证同一类型只解析一次（幂等返回同一实例）。
 *
 * @param program TypeScript Program（解析期间会临时设置 program 上下文，供
 *                resolveImportAlias 兜底遍历跨文件声明使用）
 * @param filePath 源文件绝对路径
 */
export function createLazyTypeResolver(program: ts.Program, filePath: string): LazyTypeResolver {
  const cache = new Map<string, HandlerTypeInfo | null>();
  return {
    resolve(name: string): HandlerTypeInfo | null {
      if (cache.has(name)) return cache.get(name)!;
      const info = extractTypeInfo(program, filePath, name);
      cache.set(name, info);
      return info;
    },
  };
}

/**
 * 包装类型解析，捕获 SchemaExtractionError 并补充文件路径和类型名上下文
 *
 * 只包装一次（最外层），避免嵌套调用时重复包装。
 */
function withFileContext<T>(filePath: string, typeName: string, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof SchemaExtractionError) {
      // 补充文件路径和类型名，只包装一次；保留行号位置（错误在类型文件中的精确定位）
      const fileName = filePath.split('/').pop() ?? filePath;
      const enriched = new SchemaExtractionError(
        err.typeText,
        `${err.reason}（文件: ${fileName}, 类型: ${typeName}）`,
        { cause: err },
        err.location,
      );
      throw enriched;
    }
    throw err;
  }
}
