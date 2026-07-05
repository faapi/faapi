import {
  collectRouteSchemaSources,
  getInputTypeForMethod,
  type RouteManifest,
  type RouteInfo,
  type RouteInputSchema,
  type RouteParamSchema,
  type RuntimeType,
  type PropertyType,
} from '@faapi/faapi';

/**
 * 从路由清单生成接口描述信息
 *
 * 直接调用主包 `collectRouteSchemaSources` 执行 AST 分析，提取每个路由 handler 的
 * 输入参数类型，无需依赖运行时 schemaRegistry。
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

  return routes.map((route) => {
    const inputs = extractInputSchemas(route, sourceMap);
    return {
      method: route.method,
      path: route.urlPath,
      filePath: route.filePath,
      isDynamic: route.isDynamic,
      inputs,
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
