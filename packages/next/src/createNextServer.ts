/**
 * @faapi/next — Next.js + faapi 集成插件
 *
 * 通过 faapi.config.ts 的 plugins 字段加载，在 server.listen 之前包装 handler：
 * - /api/* 走 faapi handler
 * - 其余走 Next.js getRequestHandler
 *
 * WS upgrade 同步分流：faapi WS 路由走原始 upgrade handler，其余走 Next.js HMR。
 *
 * @see createNextServer.md 设计要点与使用场景
 */
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FaapiPlugin, PluginContext, RequestHandler, UpgradeHandler } from '@faapi/faapi';

/**
 * Next.js 应用最小类型定义
 *
 * next 作为 optional peerDependency，不强制安装；这里只声明插件用到的字段，
 * 避免直接依赖 next 包的类型。
 */
interface NextApp {
  getRequestHandler(): (req: IncomingMessage, res: ServerResponse) => Promise<unknown>;
  prepare(): Promise<void>;
  getUpgradeHandler?(): (req: IncomingMessage, socket: unknown, head: Buffer) => void;
}

/** 插件选项（来自 faapi.config.ts plugins 声明的第二个元素或 options 字段） */
export interface NextPluginOptions {
  /** 开发模式，默认 NODE_ENV !== 'production' */
  dev?: boolean;
  /** Next.js 项目目录，默认 '.' */
  dir?: string;
  /** faapi API 路径前缀，默认 '/api'；匹配此前缀的请求走 faapi，其余走 Next.js */
  apiPrefix?: string;
}

/** 默认 API 前缀 */
const DEFAULT_API_PREFIX = '/api';

/**
 * 判断 pathname 是否匹配 apiPrefix
 *
 * apiPrefix '/api' 匹配 '/api' 和 '/api/*'，不匹配 '/api2'
 */
function isApiPath(pathname: string, apiPrefix: string): boolean {
  return pathname === apiPrefix || pathname.startsWith(apiPrefix + '/');
}

/**
 * Next.js + faapi 集成插件
 *
 * 通过 faapi.config.ts 的 plugins 字段加载：
 *
 * ```ts
 * export default {
 *   plugins: [
 *     ['@faapi/next', { dir: '.' }]  // 带选项的元组
 *   ],
 * } satisfies FaapiConfig;
 * ```
 *
 * 启动时用 `faapi` 命令，自动集成 Next.js，无需写 custom server 代码。
 */
const nextPlugin: FaapiPlugin = {
  name: '@faapi/next',

  async setup(ctx: PluginContext): Promise<void> {
    const options = (ctx.options as NextPluginOptions) ?? {};
    const dev = options.dev ?? process.env.NODE_ENV !== 'production';
    // dir 相对于项目根目录解析（CLI 形态下 rootDir === process.cwd()，行为不变；
    // 库 API 形态下 rootDir 可能不同，按 rootDir 解析更合理）
    const dir = path.resolve(ctx.rootDir, options.dir ?? '.');
    const apiPrefix = options.apiPrefix ?? DEFAULT_API_PREFIX;

    // 1. 动态 import next（peerDependency，未安装时报错）
    let nextFactory: (opts: { dev: boolean; dir: string }) => NextApp;
    try {
      nextFactory = (await import('next')).default as typeof nextFactory;
    } catch {
      throw new Error('[faapi-next] next 包未安装。请运行 `pnpm add next` 安装 Next.js。');
    }

    // 2. 启动 Next.js
    const nextApp = nextFactory({ dev, dir });
    const nextHandle = nextApp.getRequestHandler();
    await nextApp.prepare();

    // 3. Next.js upgrade handler（dev 模式 HMR）
    const nextUpgradeHandler =
      typeof nextApp.getUpgradeHandler === 'function' ? nextApp.getUpgradeHandler() : null;

    // 4. 包装 HTTP handler：/api/* 走 faapi，其余走 Next.js
    ctx.wrapHandler?.((original: RequestHandler): RequestHandler => {
      return (req, res) => {
        const { pathname } = new URL(req.url ?? '/', 'http://localhost');
        if (isApiPath(pathname, apiPrefix)) {
          original(req, res);
        } else {
          // 不传 parsedUrl，让 Next.js 内部解析 req.url
          // NextUrlWithParsedQuery 是 url.parse() 返回的结构，不是 URL 对象
          // 用 Promise.resolve 包装，兼容 handler 返回 undefined 的情况
          Promise.resolve(nextHandle(req, res)).catch((err: unknown) => {
            console.error('[faapi-next] Next.js handler error:', err);
            if (!res.headersSent) {
              res.statusCode = 500;
              res.end('Next.js handler error');
            }
          });
        }
      };
    });

    // 5. 包装 WS upgrade handler：/api/* 走 faapi，其余走 Next.js HMR
    ctx.wrapUpgradeHandler?.((original: UpgradeHandler | undefined): UpgradeHandler => {
      return (req, socket, head) => {
        const { pathname } = new URL(req.url ?? '/', 'http://localhost');
        if (isApiPath(pathname, apiPrefix) && original) {
          original(req, socket, head);
        } else if (nextUpgradeHandler) {
          nextUpgradeHandler(req, socket, head);
        } else {
          socket.destroy();
        }
      };
    });

    console.log(
      `- Next.js integration: ${dev ? 'dev' : 'prod'} mode, dir=${dir}, apiPrefix=${apiPrefix}`,
    );
  },
};

export default nextPlugin;
export type { FaapiPlugin, PluginContext, RequestHandler, UpgradeHandler } from '@faapi/faapi';
