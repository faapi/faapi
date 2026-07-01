import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from './parseArgs';
import { scanRoutes } from '../router/scanRoutes';
import { sortRoutes } from '../router/sortRoutes';
import { detectRouteConflicts } from '../router/detectRouteConflicts';
import { startServer, applyPluginWrappers } from '../server/startServer';
import { generateTypes } from './generateTypes';
import { startWatcher } from './watcher';
import { loadConfig } from '../config/loadConfig';
import { generateSchemaFile, loadSchemaToRegistry } from './generateSchema';
import { hydrateRoutes, type SerializedRouteManifest } from './generateRoutes';
import { compileRoutes } from './compileRoutes';
import { loadPlugins } from './loadPlugins';
import { importWithCacheBust } from '../utils/importWithCacheBust';
import type { RouteManifest, WsRouteManifest } from '../router/routeTypes';

/** dev 模式产物目录 */
const DEV_OUT_DIR = '.faapi/dev';
/** build/start 模式产物目录 */
const PROD_OUT_DIR = 'dist';

/**
 * CLI 启动命令的完整流程
 *
 * 参考 Next.js 实现：dev 和 start 共用"加载中间产物"路径，差异仅在产物来源。
 *
 * dev 模式（`faapi` 或 `faapi dev`）：
 * 1. 解析参数
 * 2. 加载配置
 * 3. 编译 src 下所有 .ts → .faapi/dev 下对应 .js（esbuild，含别名重写）
 * 4. 扫描路由（import 产物 .js 拿方法名，filePath 保持源码 .ts）
 * 5. 排序路由 + 检测冲突
 * 6. 预生成 schema 到 `.faapi/dev/faapi-schema.js`，再加载（与 start 统一）
 * 7. 生成类型文件（可选）
 * 8. 启动 server
 * 9. 执行 onReady 生命周期钩子
 * 10. 启动 watch 模式（增量编译 + 重新生成 schema + 热替换路由）
 *
 * start 模式（`faapi start`，生产模式）：
 * 1. 解析参数
 * 2. 加载配置
 * 3. 从 `dist/faapi-routes.js` 读取清单，水合（加载中间件）
 * 4. 排序路由 + 检测冲突
 * 5. 从 `dist/faapi-schema.js` 加载 schema
 * 6. 启动 server
 * 7. 执行 onReady 生命周期钩子
 *
 * dev 和 start 共用 createServer / handleRequest / validateInput，
 * 差异仅在产物目录（.faapi/dev vs dist）、是否编译、是否启动 watch。
 *
 * @param argv 原始 CLI 参数（含命令词 dev/start，由 parseArgs 解析）
 */
export async function startCommand(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const rootDir = process.cwd();
  const isProd = args.mode === 'start';
  const prodDir = isProd ? PROD_OUT_DIR : DEV_OUT_DIR;

  // start 模式要求 dist/faapi-routes.js 和 dist/faapi-schema.js 存在（由 faapi build 生成）
  if (isProd) {
    const routesPath = path.resolve(rootDir, PROD_OUT_DIR, 'faapi-routes.js');
    const schemaPath = path.resolve(rootDir, PROD_OUT_DIR, 'faapi-schema.js');
    if (!fs.existsSync(routesPath) || !fs.existsSync(schemaPath)) {
      console.error(
        '[faapi] dist/faapi-routes.js 或 dist/faapi-schema.js 不存在，请先执行 `faapi build` 构建生产产物。',
      );
      process.exit(1);
    }
  }

  if (isProd) {
    // 同步 NODE_ENV 给生态（如 Next.js 运行时 20+ 处直接读 process.env.NODE_ENV 做分支）
    // 仅在未显式设置时回退，避免覆盖用户意图
    if (!process.env.NODE_ENV) process.env.NODE_ENV = 'production';
    console.log('- Production mode');
  } else {
    // 标记 dev 模式
    process.env.__FAAPI_DEV__ = '1';
    if (!process.env.NODE_ENV) process.env.NODE_ENV = 'development';
    console.log('- Development mode');
  }

  // 加载配置文件
  const config = await loadConfig(rootDir, args.config);
  if (config) {
    console.log('- Config loaded');
  }

  // 路由获取：start 读清单+水合，dev 编译+扫描文件系统
  let routes: RouteManifest;
  let wsRoutes: WsRouteManifest;
  if (isProd) {
    // start 模式：从 dist/faapi-routes.js 读取序列化清单，水合（加载中间件）
    const routesPath = path.resolve(rootDir, PROD_OUT_DIR, 'faapi-routes.js');
    const serialized = (await importWithCacheBust(routesPath)) as unknown as SerializedRouteManifest;
    const hydrated = await hydrateRoutes(serialized);
    routes = hydrated.routes;
    wsRoutes = hydrated.wsRoutes;
    console.log(`- Routes loaded: ${routes.length} routes, ${wsRoutes.length} WS routes`);
  } else {
    // dev 模式：先编译 src/**/*.ts → .faapi/dev/**/*.js，再扫描路由（import 产物 .js）
    console.log('- Compiling TypeScript...');
    await compileRoutes({ rootDir, appDir: args.appDir, outDir: DEV_OUT_DIR });
    const scanned = await scanRoutes(rootDir, args.patterns, args.appDir, DEV_OUT_DIR);
    routes = scanned.routes;
    wsRoutes = scanned.wsRoutes;
    console.log(`- Routes scanned: ${routes.length} routes, ${wsRoutes.length} WS routes`);
  }
  const sorted = sortRoutes(routes);

  // 检测路由冲突（相同 method + urlPath 的多个文件）
  const conflicts = detectRouteConflicts(sorted);
  if (conflicts.length > 0) {
    for (const conflict of conflicts) {
      console.warn(`! 路由冲突: ${conflict.method} ${conflict.urlPath}`);
      for (const file of conflict.files) {
        console.warn(`  - ${file}`);
      }
    }
  }

  // 加载 schema：dev 预生成到 .faapi/dev/，start 直接读 dist/
  // dev 模式：route.filePath 是源码路径，schema key 也是源码路径，不需要 remap
  // start 模式：route.filePath 是产物路径，schema key 需 remap 为产物路径
  const schemaPath = path.resolve(rootDir, prodDir, 'faapi-schema.js');
  if (!isProd) {
    // dev 模式：预生成 schema 文件（AST 从源码 .ts，与 build 一致）
    await generateSchemaFile(sorted, rootDir, schemaPath);
  }
  await loadSchemaToRegistry(schemaPath, rootDir, prodDir, isProd);
  console.log(`- Schema loaded: ${schemaPath}`);

  // 生成类型文件（仅 dev 启动时）
  if (!isProd && args.types) {
    const typesPath = path.resolve(rootDir, args.types);
    await generateTypes(sorted, rootDir, typesPath);
    console.log(`- Types generated: ${typesPath}`);
  }

  // 自定义业务配置（排除 FaapiConfig 内置 key）
  const pluginConfig = config
    ? Object.fromEntries(Object.entries(config).filter(([k]) => !isFaapiConfigKey(k)))
    : {};

  const server = await startServer({
    port: args.port,
    routes: sorted,
    rootDir,
    cors: config?.cors ?? args.cors,
    staticDir: config?.staticDir ?? args.staticDir,
    responseFormat: config?.responseFormat,
    errorFormat: config?.errorFormat,
    onError: config?.lifecycle?.onError,
    config: config ?? undefined,
    wsRoutes,
    middlewares: config?.middlewares,
    injectors: config?.injectors,
    // beforeListen：加载插件并应用 handler 包装（在 server.listen 之前）
    beforeListen: async (server) => {
      const { handlerWrappers, upgradeWrappers } = await loadPlugins(config?.plugins, {
        rootDir,
        routes: sorted,
        server,
        config: pluginConfig,
      });
      applyPluginWrappers(server, handlerWrappers, upgradeWrappers);
    },
  });

  // 执行 onReady 生命周期钩子
  if (config?.lifecycle?.onReady) {
    await config.lifecycle.onReady({
      rootDir,
      routes: sorted,
      server,
    });
    console.log('- onReady hook executed');
  }

  // 注册 onClose 生命周期钩子
  if (config?.lifecycle?.onClose) {
    const onClose = config.lifecycle.onClose;
    const gracefulShutdown = async (signal: string) => {
      console.log(`\n- Received ${signal}, running onClose hook...`);
      await onClose({ rootDir, routes: sorted, server });
      process.exit(0);
    };
    process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => void gracefulShutdown('SIGINT'));
  }

  // 启动 watch 模式（仅 dev）
  if (!isProd) {
    startWatcher({
      rootDir,
      patterns: args.patterns,
      appDir: args.appDir,
      server,
      port: args.port,
      cors: args.cors,
      staticDir: args.staticDir,
      types: args.types,
    });
  }
}

/** FaapiConfig 的内置 key 集合（排除自定义业务配置） */
const FAAPI_CONFIG_KEYS = new Set([
  'port',
  'staticDir',
  'cors',
  'responseFormat',
  'errorFormat',
  'lifecycle',
  'middlewares',
  'injectors',
  'extendContext',
  'plugins',
]);

function isFaapiConfigKey(key: string): boolean {
  return FAAPI_CONFIG_KEYS.has(key);
}
