import path from 'node:path';
import {
  getSchemaProperties,
  getInputTypeForMethod,
  type RouteManifest,
  type RouteInfo,
  type RouteInputSchema,
} from '@faapi/faapi';

/**
 * 从路由清单生成接口描述信息
 *
 * 复用主包 schemaRegistry 已有的类型提取结果，避免重复 AST 分析。
 *
 * @param routes 路由清单
 * @param rootDir 根目录
 */
export function buildRouteSchemas(routes: RouteManifest, rootDir: string): RouteInfo[] {
  return routes.map((route) => {
    const absoluteFilePath = path.resolve(rootDir, route.filePath);
    const inputs = extractInputSchemas(absoluteFilePath, route.method, route);

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
 * 提取一个路由文件的所有输入 schema
 *
 * 直接查询 schemaRegistry，复用参数校验已提取的 PropertyType，
 * 不再重复执行 AST 分析。
 */
function extractInputSchemas(
  filePath: string,
  method: string,
  route: { isDynamic: boolean; paramNames: string[] },
): RouteInputSchema[] {
  const inputs: RouteInputSchema[] = [];

  // 主输入（query 或 body）：从 registry 查询
  const inputType = getInputTypeForMethod(method);
  const schema = getSchemaProperties(filePath, method, inputType);

  if (schema) {
    inputs.push({
      source: inputType,
      schemaName: schema.schemaName,
      properties: schema.properties,
    });
  } else {
    // registry 无数据（不应发生，插件 setup 时 registry 已加载）
    inputs.push({
      source: inputType,
      schemaName: null,
      properties: [],
    });
  }

  // 动态路由参数
  if (route.isDynamic && route.paramNames.length > 0) {
    const paramsSchema = getSchemaProperties(filePath, method, 'params');

    // params 有类型声明时用类型信息，否则用 paramNames 兜底
    const paramsProps =
      paramsSchema && paramsSchema.schemaName
        ? paramsSchema.properties
        : route.paramNames.map((name) => ({
            name,
            type: 'string',
            required: true,
          }));

    inputs.push({
      source: 'params',
      schemaName: paramsSchema?.schemaName ?? null,
      properties: paramsProps,
    });
  }

  return inputs;
}
