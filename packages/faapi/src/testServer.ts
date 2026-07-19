import type { Server } from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { scanRoutes } from './router/scanRoutes';
import { sortRoutes } from './router/sortRoutes';
import { generateSchemaFiles } from './cli/generateSchemaFiles';
import { invalidateSchemaCache } from './validator/validateInput';
import { createServer } from './server/createServer';
import type { RouteManifest, WsRouteManifest } from './router/routeTypes';
import type { FaapiMiddleware } from './middleware/middlewareTypes';
import type { InjectorMap } from './middleware/injectorTypes';
import type { CorsOptions } from './middleware/cors';
import type { HelmetOptions } from './middleware/helmet';
import type { LoggerOptions } from './middleware/logger';
import type { FaapiContext } from './runtime/contextTypes';

/**
 * createTestServer 入参
 *
 * 业务方一行代码启动带 schema 校验的 E2E 测试服务器。
 * 详见 src/testServer.md。
 */
export interface TestServerOptions {
  /** 项目根目录（路由源码所在，必填） */
  rootDir: string;
  // 路由扫描 glob，相对 rootDir；默认 ['src/api/**/*.ts']
  patterns?: string[];
  /**
   * schema 产物输出目录（绝对路径或相对 rootDir）。
   * 不传时自动 mkdtemp 生成临时目录，close() 时清理。
   * 传值时 close() 仍会清理该目录。
   */
  dist?: string;
  /** CORS 中间件配置，默认 false（禁用，避免污染断言） */
  cors?: CorsOptions | boolean;
  /** 安全头配置，默认 false */
  helmet?: HelmetOptions | boolean;
  /** 请求日志配置，默认 false（避免污染测试输出） */
  logger?: LoggerOptions | boolean;
  /** 全局中间件（外层洋葱） */
  middlewares?: FaapiMiddleware[];
  /** 全局注入器 */
  injectors?: InjectorMap;
  /** 请求错误钩子（在错误响应生成后调用，用于副作用） */
  onError?: (error: unknown, ctx: FaapiContext) => Promise<void> | void;
  /** 业务配置（注入到 ctx.config） */
  config?: Record<string, unknown>;
  /** 请求体大小限制（字节），默认 10MB */
  bodyLimit?: number;
}

/**
 * createTestServer 返回值
 *
 * 业务方通过 baseUrl 发 fetch 请求，close() 一行完成 teardown。
 */
export interface TestServer {
  /** Node.js HTTP Server 实例（已 listen） */
  server: Server;
  /** 形如 http://localhost:<随机端口> */
  baseUrl: string;
  /** 排序后的路由清单 */
  routes: RouteManifest;
  /** WebSocket 路由清单 */
  wsRoutes: WsRouteManifest;
  /** schema 临时目录绝对路径（业务方调试时可查看生成的 zod.js） */
  schemaDist: string;
  /**
   * 关闭 server + 清理 schema 目录 + 清空 schema 模块缓存
   *
   * 内部顺序：
   * 1. server.closeAllConnections?.()（Node 18+，强制断开 WS / 长连接）
   * 2. server.close()
   * 3. fs.rm(schemaDist, { recursive, force })
   * 4. invalidateSchemaCache()
   *
   * 幂等：重复调用不会重复清理。
   */
  close(): Promise<void>;
}

/** 默认路由扫描 glob */
const DEFAULT_PATTERNS = ['src/api/**/*.ts'];

/** 默认请求体大小限制：10MB */
const DEFAULT_BODY_LIMIT = 10 * 1024 * 1024;

/**
 * 一键启动带 schema 校验的 E2E 测试服务器
 *
 * 内部流程：
 * 1. scanRoutes 扫描路由
 * 2. sortRoutes 排序
 * 3. mkdtemp 创建临时 schema 目录（或用传入的 dist）
 * 4. generateSchemaFiles 生成 zod.js
 * 5. createServer 创建 server（默认禁用 CORS/Helmet/Logger，避免污染断言）
 * 6. server.listen(0) 随机端口
 * 7. 返回 TestServer
 *
 * 详见 src/testServer.md。
 *
 * @param options rootDir 必填，其余可选
 * @returns TestServer 实例
 */
export async function createTestServer(options: TestServerOptions): Promise<TestServer> {
  const {
    rootDir,
    patterns = DEFAULT_PATTERNS,
    dist,
    cors = false,
    helmet = false,
    logger = false,
    middlewares,
    injectors,
    onError,
    config,
    bodyLimit = DEFAULT_BODY_LIMIT,
  } = options;

  // 1. 扫描 + 排序路由
  const { routes, wsRoutes } = await scanRoutes(rootDir, patterns);
  const sorted = sortRoutes(routes);

  // 2. schema 临时目录（未传 dist 时自动 mkdtemp）
  const schemaDist = dist
    ? path.isAbsolute(dist)
      ? dist
      : path.resolve(rootDir, dist)
    : await fs.mkdtemp(path.join(os.tmpdir(), 'faapi-test-schema-'));

  // 3. 生成 zod.js
  await generateSchemaFiles(sorted, rootDir, schemaDist);

  // 4. 创建 server（默认禁用 CORS/Helmet/Logger，避免污染断言）
  const { server } = createServer({
    routes: sorted,
    rootDir,
    dist: schemaDist,
    cors,
    helmet,
    logger,
    middlewares,
    injectors,
    onError,
    config,
    wsRoutes,
    bodyLimit,
  });

  // 5. listen(0) 随机端口
  const baseUrl = await listenOnRandomPort(server);

  // 6. 关闭状态标记（幂等保护）
  let closed = false;

  const testServer: TestServer = {
    server,
    baseUrl,
    routes: sorted,
    wsRoutes,
    schemaDist,

    async close(): Promise<void> {
      if (closed) return;
      closed = true;

      // 强制断开 WS / 长连接（Node 18+）
      const s = server as Server & {
        closeAllConnections?: () => void;
        closeIdleConnections?: () => void;
      };
      s.closeAllConnections?.();
      s.closeIdleConnections?.();

      // 关闭 HTTP server
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });

      // 清理 schema 临时目录（失败不阻塞 close 流程；force: true 已尽可能容错）
      await fs.rm(schemaDist, { recursive: true, force: true }).catch(() => {
        /* 清理失败不阻塞：closed 标记已设，目录可能在 OS 临时目录被外部清理 */
      });

      // 清空 schema 模块缓存，避免串扰后续测试
      invalidateSchemaCache();
    },
  };

  return testServer;
}

/**
 * server.listen(0) 取随机端口，返回 http://localhost:<port>
 *
 * 抽出来便于失败时抛清晰错误。
 */
function listenOnRandomPort(server: Server): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    server.listen(0, () => {
      const addr = server.address();
      if (typeof addr === 'object' && addr !== null) {
        resolve(`http://localhost:${addr.port}`);
      } else {
        reject(new Error('Failed to get server address'));
      }
    });
    server.on('error', (err) => {
      reject(err);
    });
  });
}
