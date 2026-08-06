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
  /**
   * 是否自动开启 Next.js 的 experimental.trustHostHeader，默认 true
   *
   * 反向代理（Nginx/Caddy 等）场景下，Next.js 默认用固定的 hostname:port 构造
   * initURL（如 https://localhost:3000/path），忽略代理透传的 Host 头，导致
   * SSR 重定向/链接指向错误域名。开启 trustHostHeader 后，Next.js 直接用
   * req.headers.host 构造 URL，正确反映客户端原始请求。
   *
   * 实现方式：插件用 Next.js 的 loadConfig 加载用户 next.config.ts，合并
   * experimental.trustHostHeader=true，再通过 next() 的 conf 选项传入。
   * 用户在 next.config.ts 中的其他配置会被保留。若加载失败则退回不传 conf，
   * 此时需手动在 next.config.ts 中配置。
   *
   * 设为 false 可禁用此行为（如非反向代理场景，或用户想手动控制）。
   */
  trustHostHeader?: boolean;
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
    const trustHostHeader = options.trustHostHeader ?? true;

    // 1. 动态 import next（peerDependency，未安装时报错）
    let nextFactory: (opts: { dev: boolean; dir: string; conf?: unknown }) => NextApp;
    try {
      nextFactory = (await import('next')).default as typeof nextFactory;
    } catch {
      throw new Error('[faapi-next] next 包未安装。请运行 `pnpm add next` 安装 Next.js。');
    }

    // 2. 构造 conf：若开启 trustHostHeader，加载用户 next.config.ts 并合并
    //    experimental.trustHostHeader=true。loadConfig 返回完整配置（已 normalize
    //    + 填充默认值），展开后覆盖 experimental 字段，再通过 conf 传给 next()。
    //    注意：传 conf 会让 Next.js 跳过读取 next.config.ts，所以这里必须加载
    //    用户配置以保留 next.config.ts 中的其他设置（images/rewrites 等）。
    let conf: Record<string, unknown> | undefined;
    if (trustHostHeader) {
      conf = await loadUserConfigAndMergeTrustHostHeader(dir, dev);
    }

    // 3. 启动 Next.js
    const nextApp = nextFactory(conf ? { dev, dir, conf } : { dev, dir });
    const nextHandle = nextApp.getRequestHandler();
    await nextApp.prepare();

    // 4. Next.js upgrade handler（dev 模式 HMR）
    const nextUpgradeHandler =
      typeof nextApp.getUpgradeHandler === 'function' ? nextApp.getUpgradeHandler() : null;

    // 5. 包装 HTTP handler：/api/* 走 faapi，其余走 Next.js
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

    // 6. 包装 WS upgrade handler：/api/* 走 faapi，其余走 Next.js HMR
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
      `- Next.js integration: ${dev ? 'dev' : 'prod'} mode, dir=${dir}, apiPrefix=${apiPrefix}${conf ? ', trustHostHeader=auto' : ''}`,
    );
  },
};

/**
 * 加载用户 next.config.{js,ts,mjs}，合并 experimental.trustHostHeader=true，
 * 返回可传给 next() conf 选项的配置对象。
 *
 * 用 Next.js 内部的 loadConfig（next/dist/server/config）加载完整配置（已 normalize
 * + 填充默认值），展开后覆盖 experimental.trustHostHeader。这样用户在 next.config.ts
 * 中的其他配置（images/rewrites/redirects 等）都会被保留。
 *
 * 失败时返回 undefined（退回不传 conf，Next.js 自己加载 next.config.ts，
 * trustHostHeader 不自动开启），并打印警告提示用户手动配置。
 */
async function loadUserConfigAndMergeTrustHostHeader(
  dir: string,
  dev: boolean,
): Promise<Record<string, unknown> | undefined> {
  try {
    const { PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_SERVER } = await import('next/constants');
    const configModule = (await import('next/dist/server/config')) as {
      default?: (phase: string, dir: string, opts?: unknown) => Promise<Record<string, unknown>>;
    } & Record<string, unknown>;
    // 优先取 default 导出，否则取模块本身（兼容 CJS/ESM 互操作差异）
    const loadConfig =
      configModule.default ??
      (configModule as unknown as (
        phase: string,
        dir: string,
        opts?: unknown,
      ) => Promise<Record<string, unknown>>) ??
      undefined;
    if (typeof loadConfig !== 'function') {
      throw new Error('loadConfig is not a function');
    }
    const phase = dev ? PHASE_DEVELOPMENT_SERVER : PHASE_PRODUCTION_SERVER;
    const userConfig = await loadConfig(phase, dir, { silent: true });
    if (!userConfig || typeof userConfig !== 'object') {
      return undefined;
    }
    const experimental = (userConfig.experimental as Record<string, unknown> | undefined) ?? {};
    // 用户已在 next.config.ts 显式开启则不重复设置
    // 想关闭用插件选项 trustHostHeader: false（跳过整个 loadConfig 分支）
    if (experimental.trustHostHeader === true) {
      return { ...userConfig };
    }
    return {
      ...userConfig,
      experimental: {
        ...experimental,
        trustHostHeader: true,
      },
    };
  } catch {
    console.warn(
      '[faapi-next] 自动开启 experimental.trustHostHeader 失败（无法加载 next.config.ts）。\n' +
        '  若处于反向代理（Nginx/Caddy 等）场景，请手动在 next.config.ts 中配置：\n' +
        '  experimental: { trustHostHeader: true }',
    );
    return undefined;
  }
}

export default nextPlugin;
export type { FaapiPlugin, PluginContext, RequestHandler, UpgradeHandler } from '@faapi/faapi';
