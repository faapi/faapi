import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { RouteManifest, RouteInfo, FaapiPlugin, PluginContext } from '@faapi/faapi';
import { buildRouteSchemas } from './routeSchema';

/**
 * 判断 schema server 是否应该启用
 * - FAAPI_SCHEMA=1 强制开启
 * - FAAPI_SCHEMA=0 强制关闭
 * - 未设置时：开发环境默认开启，生产环境默认关闭
 */
export function isSchemaEnabled(): boolean {
  const envValue = process.env.FAAPI_SCHEMA;
  if (envValue === '1' || envValue === 'true') return true;
  if (envValue === '0' || envValue === 'false') return false;
  // 未设置时根据 NODE_ENV 判断
  return process.env.NODE_ENV !== 'production';
}

/**
 * 创建 faapi Schema Server
 * 通过 MCP 协议暴露路由信息供 LLM 查询
 */
export function createSchemaServer(routes: RouteManifest, rootDir: string): McpServer {
  const server = new McpServer({
    name: 'faapi-schema',
    version: '0.0.1',
  });

  // 缓存 route schemas
  let cachedSchemas: RouteInfo[] | null = null;

  function getSchemas(): RouteInfo[] {
    if (!cachedSchemas) {
      cachedSchemas = buildRouteSchemas(routes, rootDir);
    }
    return cachedSchemas;
  }

  // Tool: 列出所有路由
  server.tool(
    'list_routes',
    '列出当前 faapi 应用的所有 API 路由，包括方法、路径、是否动态路由',
    {},
    () => {
      const schemas = getSchemas();
      const routesList = schemas.map((r) => ({
        method: r.method,
        path: r.path,
        isDynamic: r.isDynamic,
        filePath: r.filePath,
      }));
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(routesList, null, 2),
          },
        ],
      };
    },
  );

  // Tool: 获取单个路由的详细 schema
  server.tool(
    'get_route_schema',
    '获取指定路由的详细接口信息，包括输入参数的名称、类型、是否必填',
    {
      method: z.string().describe('HTTP 方法，如 GET、POST'),
      path: z.string().describe('路由路径，如 /auth/login'),
    },
    ({ method, path }) => {
      const schemas = getSchemas();
      const route = schemas.find((r) => r.method === method.toUpperCase() && r.path === path);

      if (!route) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: `未找到路由 ${method.toUpperCase()} ${path}` }),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(route, null, 2),
          },
        ],
      };
    },
  );

  // Tool: 获取所有路由的完整 schema（类似 OpenAPI）
  server.tool(
    'get_api_schema',
    '获取当前应用所有接口的完整 schema，类似 OpenAPI 规范，包含每个路由的输入参数定义',
    {},
    () => {
      const schemas = getSchemas();
      const apiSchema: Record<string, unknown> = {};

      for (const route of schemas) {
        const key = `${route.method} ${route.path}`;
        apiSchema[key] = {
          method: route.method,
          path: route.path,
          isDynamic: route.isDynamic,
          inputs: route.inputs.map((input) => ({
            source: input.source,
            schemaName: input.schemaName,
            properties: input.properties,
          })),
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(apiSchema, null, 2),
          },
        ],
      };
    },
  );

  return server;
}

/**
 * 启动 Schema Server（stdio 模式）
 */
export async function startSchemaServer(routes: RouteManifest, rootDir: string): Promise<void> {
  const server = createSchemaServer(routes, rootDir);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/**
 * faapi 插件入口
 *
 * 在 faapi.config.ts 中声明：
 * ```ts
 * export default {
 *   plugins: ['@faapi/schema'],
 * } satisfies FaapiConfig;
 * ```
 */
export default {
  name: '@faapi/schema',
  setup(ctx: PluginContext) {
    if (!isSchemaEnabled()) {
      console.log('- Schema server disabled (FAAPI_SCHEMA=0 or production mode)');
      return;
    }
    console.log('- Schema server enabled (stdio)');
    // startSchemaServer 是异步的，但不阻塞启动流程
    void startSchemaServer(ctx.routes, ctx.rootDir);
  },
} satisfies FaapiPlugin;
