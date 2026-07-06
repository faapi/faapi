/**
 * faapi Schema Server — 通过 MCP 协议以 resource 形式暴露路由 schema 供 AI 助手查询
 *
 * 基于 @faapi/mcp（纯手写 MCP Server SDK），不依赖 @modelcontextprotocol/sdk。
 * 通过 faapi 插件机制挂载到 /mcp 端点，AI 助手通过 Streamable HTTP 连接。
 *
 * 提供两种 MCP 能力:
 * - resources: 每个路由注册为静态 resource + by-method resourceTemplate
 * - completion: 为 resource template 的 method 参数提供补全
 *
 * 不注册 tool——查 schema 是读数据(resource 语义),不是执行动作(tool 语义)。
 * resource 还有 AI 客户端原生 UI、可缓存、支持 subscription 等 tool 做不到的优势。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createMcpServer, createMcpNodeHandler, type McpServer } from '@faapi/mcp';
import type { RouteManifest, RouteInfo, FaapiPlugin, PluginContext } from '@faapi/faapi';
import { buildRouteSchemas } from './routeSchema';

/** MCP 端点路径 */
const MCP_PATH = '/mcp';

/** 合法 HTTP 方法集合(用于 template read 校验 + completion 候选值) */
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'] as const;

/**
 * 从 package.json 读取版本号
 *
 * 通过 import.meta.url 解析 ../package.json，dev 模式下指向源文件所在包根目录，
 * prod 模式下指向 dist/ 同级的包根目录。模块加载时一次性读取。
 */
function readPackageVersion(): string {
  const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string };
  return pkg.version ?? '0.0.0';
}

/** 构造路由 resource 的 URI */
function routeToUri(route: { method: string; path: string }): string {
  return `faapi://route/${route.method}${route.path}`;
}

/**
 * 创建 Schema MCP Server
 *
 * 注册:
 * - 每个路由一个静态 resource(URI: faapi://route/{METHOD}{PATH})
 * - 1 个 resourceTemplate(faapi://routes/by-method/{method},按方法过滤)
 * - 1 个 completion(为 template 的 method 参数提供候选值)
 *
 * @param getRoutes 返回最新路由清单的 getter（dev reloadRoutes 后返回更新后的数组）
 * @param rootDir 项目根目录（用于 AST 分析解析源文件）
 */
export function createSchemaServer(getRoutes: () => RouteManifest, rootDir: string): McpServer {
  const mcp = createMcpServer({
    name: 'faapi-schema',
    version: readPackageVersion(),
    // 路由变化时主动推送 notifications/resources/list_changed
    resourcesListChanged: true,
  });

  // 缓存 route schemas：通过路由数组引用比较检测变更
  let cachedRoutes: RouteManifest | null = null;
  let cachedSchemas: RouteInfo[] | null = null;
  // 已注册的 resource URI 集合(变更时先 remove 再注册,避免重复注册抛错)
  const registeredUris = new Set<string>();
  // 标记是否已首次注册(首次无需推送 list_changed,因为没有 session)
  let resourceRegistered = false;

  function getSchemas(): RouteInfo[] {
    const currentRoutes = getRoutes();
    if (currentRoutes !== cachedRoutes || !cachedSchemas) {
      cachedRoutes = currentRoutes;
      cachedSchemas = buildRouteSchemas(currentRoutes, rootDir);
      registerResources(cachedSchemas);
      // 非首次注册时通知客户端列表变更
      if (resourceRegistered) {
        mcp.notifyResourcesListChanged();
      }
      resourceRegistered = true;
    }
    return cachedSchemas;
  }

  /** 重新注册所有静态 resource(先清空旧的,再注册新的) */
  function registerResources(schemas: RouteInfo[]): void {
    // 清空旧 resource
    for (const uri of registeredUris) {
      mcp.removeResource(uri);
    }
    registeredUris.clear();

    // 注册新 resource
    for (const route of schemas) {
      const uri = routeToUri(route);
      // 闭包捕获当前 route,避免循环变量引用问题
      const captured = route;
      mcp.resource(uri, {
        name: `${route.method} ${route.path}`,
        mimeType: 'application/json',
        read: async () => ({
          contents: [
            {
              uri,
              mimeType: 'application/json',
              text: JSON.stringify(captured, null, 2),
            },
          ],
        }),
      });
      registeredUris.add(uri);
    }
  }

  // ─── ResourceTemplate: 按方法过滤路由 ─────────────────
  mcp.resourceTemplate('faapi://routes/by-method/{method}', {
    name: 'routes-by-method',
    description: '按 HTTP 方法过滤路由,返回该方法的所有路由列表',
    read: async (uri, params) => {
      const method = (params.method ?? '').toUpperCase();
      // 不合法的方法返回空数组(不抛错,避免 InternalError;客户端拿不到路由自然知道方法无效)
      if (!HTTP_METHODS.includes(method as (typeof HTTP_METHODS)[number])) {
        return {
          contents: [
            {
              uri,
              mimeType: 'application/json',
              text: '[]',
            },
          ],
        };
      }
      const schemas = getSchemas().filter((r) => r.method === method);
      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(schemas, null, 2),
          },
        ],
      };
    },
  });

  // ─── Completion: method 参数补全 ──────────────────────
  mcp.completion(
    { type: 'ref/resource', uri: 'faapi://routes/by-method/{method}' },
    'method',
    (value) => {
      const upper = value.toUpperCase();
      return {
        values: HTTP_METHODS.filter((m) => m.startsWith(upper)),
      };
    },
  );

  // 触发首次 schemas 构建 + resource 注册
  // 必须在返回前调用,否则 resources/list 会返回空(懒加载不会在 list 时触发)
  getSchemas();

  return mcp;
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
 *
 * 插件在 /mcp 路径挂载 MCP 端点，AI 助手通过 Streamable HTTP 连接。
 */
export default {
  name: '@faapi/schema',
  setup(ctx: PluginContext) {
    const mcp = createSchemaServer(ctx.getRoutes, ctx.rootDir);
    const nodeHandler = createMcpNodeHandler(mcp);

    // 拦截 /mcp 路径的请求，交给 MCP handler 处理
    ctx.wrapHandler?.((original) => (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === MCP_PATH) {
        return nodeHandler(req, res);
      }
      return original(req, res);
    });

    console.log(`- Schema server enabled at ${MCP_PATH} (Streamable HTTP)`);
  },
} satisfies FaapiPlugin;
