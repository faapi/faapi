/**
 * 从路由清单生成接口描述信息（含输入参数与响应类型）
 *
 * 直接调用主包 `collectRouteSchemaSources` 执行 AST 分析，提取每个路由 handler 的
 * 输入参数类型与返回类型，无需依赖运行时 schemaRegistry。
 *
 * 响应类型提取独立实现 Promise 解包逻辑，不修改主包 resolveTypeNode
 * (主包在运行时校验场景下遇到 Promise 会抛错，响应类型提取场景需解包取 T)。
 */

import ts from 'typescript';
import {
  collectRouteSchemaSources,
  createProgram,
  invalidateProgramCache,
  extractTypeInfo,
  resolveTypeNode,
  getInputTypeForMethod,
  SchemaExtractionError,
  type RouteManifest,
  type RouteInfo,
  type RouteInputSchema,
  type RouteOutputSchema,
  type RouteParamSchema,
  type RuntimeType,
  type PropertyType,
} from '@faapi/faapi';

/**
 * 从路由清单生成接口描述信息
 *
 * @param routes 路由清单
 * @param rootDir 项目根目录（用于解析源文件绝对路径）
 */
export function buildRouteSchemas(routes: RouteManifest, rootDir: string): RouteInfo[] {
  const { sources } = collectRouteSchemaSources(routes, rootDir);

  // 按 urlPath#schemaName 索引（schemaName = `${method}${inputType}`，如 GETQuery）
  const sourceMap = new Map<string, (typeof sources)[number]>();
  for (const source of sources) {
    sourceMap.set(`${source.urlPath}#${source.schemaName}`, source);
  }

  // 按 urlPath 索引源文件绝对路径（用于响应类型提取创建 program）
  const filePathMap = new Map<string, string>();
  for (const source of sources) {
    filePathMap.set(source.urlPath, source.filePath);
  }

  return routes.map((route) => {
    const inputs = extractInputSchemas(route, sourceMap);
    const output = extractOutputSchema(route, filePathMap.get(route.urlPath));
    return {
      method: route.method,
      path: route.urlPath,
      filePath: route.filePath,
      isDynamic: route.isDynamic,
      inputs,
      output,
    };
  });
}

/**
 * 提取一个路由的所有输入 schema
 *
 * 从 sourceMap 查询 AST 提取结果；无类型声明时 properties 为空。
 * 动态路由无 params 类型声明时，用 paramNames 兜底为 string[]。
 */
function extractInputSchemas(
  route: { method: string; urlPath: string; isDynamic: boolean; paramNames: string[] },
  sourceMap: Map<
    string,
    { schemaName: string; typeInfo: { name: string; properties: PropertyType[] } | null }
  >,
): RouteInputSchema[] {
  const inputs: RouteInputSchema[] = [];

  // 主输入（query 或 body）
  const inputType = getInputTypeForMethod(route.method);
  const schemaName = `${route.method.toUpperCase()}${capitalize(inputType)}`;
  const source = sourceMap.get(`${route.urlPath}#${schemaName}`);

  if (source?.typeInfo) {
    inputs.push({
      source: inputType,
      schemaName: source.typeInfo.name,
      properties: toParamSchemas(source.typeInfo.properties),
    });
  } else {
    // 无类型声明
    inputs.push({
      source: inputType,
      schemaName: null,
      properties: [],
    });
  }

  // 动态路由参数：collectRouteSchemaSources 不提取 params 类型，用 paramNames 兜底
  if (route.isDynamic && route.paramNames.length > 0) {
    inputs.push({
      source: 'params',
      schemaName: null,
      properties: route.paramNames.map((name) => ({ name, type: 'string', required: true })),
    });
  }

  return inputs;
}

/**
 * 提取路由的响应类型
 *
 * 流程:
 * 1. 用 TypeScript Compiler API 定位 handler 函数节点
 * 2. 读取 node.type(显式返回类型注解)
 * 3. 无注解 → 返回 null
 * 4. 解包 Promise<T>(若存在)→ 解析 T
 * 5. void/Promise<void> → 返回 null
 * 6. 解析失败 catch SchemaExtractionError → 降级返回 null(不阻断整条路由 schema 构建)
 *
 * @param route 路由信息
 * @param filePath 源文件绝对路径(已由 collectRouteSchemaSources 解析)
 */
function extractOutputSchema(
  route: { method: string; urlPath: string },
  filePath: string | undefined,
): RouteOutputSchema | null {
  if (!filePath) return null;

  try {
    const program = createProgram(filePath);
    const sourceFile = program.getSourceFile(filePath);
    if (!sourceFile) return null;

    const checker = program.getTypeChecker();

    // 定位 handler 函数声明(export function GET/POST/...)
    const handlerName = route.method.toUpperCase();
    let returnTypeNode: ts.TypeNode | undefined;
    ts.forEachChild(sourceFile, (node) => {
      if (returnTypeNode) return;
      if (ts.isFunctionDeclaration(node) && node.name?.text === handlerName) {
        returnTypeNode = node.type;
      }
    });

    if (!returnTypeNode) return null;

    // 解包 Promise<T>
    const unwrapped = unwrapPromise(returnTypeNode);
    if (unwrapped === null) return null; // void

    // 解析解包后的类型
    const runtimeType = resolveTypeNode(unwrapped, checker);
    return runtimeTypeToOutput(unwrapped, runtimeType, program, filePath, checker);
  } catch (err) {
    // 解析失败降级为 null,不阻断整条路由 schema 构建
    if (err instanceof SchemaExtractionError) return null;
    throw err;
  }
}

/**
 * 解包 Promise<T> → T
 *
 * - Promise<T> → T
 * - Promise<void> → null(表示无响应类型)
 * - 非 Promise 类型 → 原样返回
 *
 * 仅解包一层,不递归(Promise<Promise<T>> 实际不会出现)。
 */
function unwrapPromise(typeNode: ts.TypeNode): ts.TypeNode | null {
  if (!ts.isTypeReferenceNode(typeNode)) return typeNode;

  const typeName = typeNode.typeName.getText();
  if (typeName !== 'Promise') return typeNode;

  // Promise 无类型参数 → 视为 Promise<any> → 原样返回(any 由 resolveTypeNode 处理)
  const arg = typeNode.typeArguments?.[0];
  if (!arg) return typeNode;

  // Promise<void> → null
  if (ts.isTypeNode(arg) && arg.kind === ts.SyntaxKind.VoidKeyword) return null;

  return arg;
}

/**
 * 将 RuntimeType + 原始类型节点转换为 RouteOutputSchema
 *
 * - 命名类型引用(TypeReference)→ 调 extractTypeInfo 提取完整结构 → properties 来自 typeInfo
 * - 数组类型 T[](TypeReference Array<T>)→ 取元素类型名,提取元素结构
 * - 内联对象字面量(TypeLiteralNode)→ 直接从 runtimeType.properties 提取
 * - 其他(基础类型/联合/元组等)→ properties 为空,schemaName 为 null
 */
function runtimeTypeToOutput(
  typeNode: ts.TypeNode,
  runtimeType: RuntimeType,
  program: ts.Program,
  filePath: string,
  _checker: ts.TypeChecker,
): RouteOutputSchema {
  // 内联对象字面量 → 直接从 runtimeType 提取 properties
  if (ts.isTypeLiteralNode(typeNode)) {
    if (runtimeType.kind === 'object') {
      return {
        schemaName: null,
        properties: toParamSchemas(runtimeType.properties),
      };
    }
  }

  // 数组类型 T[](ArrayTypeNode)→ 取元素类型提取结构
  if (ts.isArrayTypeNode(typeNode) && runtimeType.kind === 'array') {
    const element = runtimeType.element;
    // 元素是命名类型引用 → 提取元素结构
    if (element.kind === 'ref') {
      const typeInfo = extractTypeInfo(program, filePath, element.name);
      if (typeInfo) {
        return {
          schemaName: element.name,
          properties: toParamSchemas(typeInfo.properties),
        };
      }
    }
    // 元素已被 checker 展开为 object(resolveTypeNode 默认行为)→ 尝试从 AST 节点拿命名
    if (element.kind === 'object') {
      const elementNode = typeNode.elementType;
      if (elementNode && ts.isTypeReferenceNode(elementNode)) {
        const elementName = elementNode.typeName.getText();
        const typeInfo = extractTypeInfo(program, filePath, elementName);
        if (typeInfo) {
          return {
            schemaName: elementName,
            properties: toParamSchemas(typeInfo.properties),
          };
        }
      }
      // 内联对象数组({ id: number }[])
      return {
        schemaName: null,
        properties: toParamSchemas(element.properties),
      };
    }
    // 数组元素非命名类型(如 string[]、number[])
    return { schemaName: null, properties: [] };
  }

  // 命名类型引用 → 提取完整结构
  if (ts.isTypeReferenceNode(typeNode)) {
    const typeName = typeNode.typeName.getText();

    // 数组类型 Array<T>(TypeReference Array<T>)→ 取元素类型名提取结构
    if (runtimeType.kind === 'array') {
      const element = runtimeType.element;
      if (element.kind === 'ref') {
        const typeInfo = extractTypeInfo(program, filePath, element.name);
        if (typeInfo) {
          return {
            schemaName: element.name,
            properties: toParamSchemas(typeInfo.properties),
          };
        }
      }
      // 数组元素是内联对象({ id: number }[])
      if (element.kind === 'object') {
        return {
          schemaName: null,
          properties: toParamSchemas(element.properties),
        };
      }
      // 数组元素非命名类型(如 string[]、number[])
      return { schemaName: null, properties: [] };
    }

    // 命名类型引用(interface/type alias)
    if (runtimeType.kind === 'ref' || runtimeType.kind === 'object') {
      const typeInfo = extractTypeInfo(program, filePath, typeName);
      if (typeInfo) {
        return {
          schemaName: typeName,
          properties: toParamSchemas(typeInfo.properties),
        };
      }
    }
  }

  // 其他类型(基础类型/联合/元组等)
  return { schemaName: null, properties: [] };
}

/**
 * 首字母大写
 */
function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * 将 PropertyType[] 转换为 RouteParamSchema[]
 */
function toParamSchemas(properties: PropertyType[]): RouteParamSchema[] {
  return properties.map((prop) => ({
    name: prop.name,
    type: runtimeTypeToString(prop.type),
    required: !prop.optional,
  }));
}

/**
 * 将 RuntimeType 转为可读字符串
 */
function runtimeTypeToString(type: RuntimeType): string {
  switch (type.kind) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'bigint':
    case 'null':
    case 'undefined':
    case 'date':
      return type.kind;
    case 'literal':
      return JSON.stringify(type.value);
    case 'array':
      return `${runtimeTypeToString(type.element)}[]`;
    case 'tuple':
      return `[${type.elements.map((e) => (e.rest ? '...' : '') + runtimeTypeToString(e.type) + (e.optional ? '?' : '')).join(', ')}]`;
    case 'object':
      return 'object';
    case 'union':
      return type.members.map(runtimeTypeToString).join(' | ');
    case 'record':
      return `Record<${runtimeTypeToString(type.key)}, ${runtimeTypeToString(type.value)}>`;
    case 'ref':
      return type.name;
    case 'any':
    case 'unknown':
      return 'unknown';
    default:
      return 'unknown';
  }
}

// 显式导出 invalidateProgramCache 便于测试清理缓存
export { invalidateProgramCache };
