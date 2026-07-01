import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from './parseArgs';
import { scanRoutes } from '../router/scanRoutes';
import { sortRoutes } from '../router/sortRoutes';
import { detectRouteConflicts } from '../router/detectRouteConflicts';
import { startServer, applyPluginWrappers } from '../server/startServer';
import { generateTypes } from './generateTypes';
import { startWatcher } from './watcher';
import { loadConfig } from '../config/loadConfig';
import { schemaRegistry } from '../validator/schemaRegistry';
import { extractSchemasForRoutes, readManifestFile } from './generateSchema';
import { hydrateRoutes } from './generateRoutes';
import { loadPlugins } from './loadPlugins';
import type { SchemaManifest } from '../validator/schemaRegistry';

/**
 * CLI 启动命令的完整流程
 *
 * dev 模式（默认，`faapi` 或 `faapi dev`）：
 * 1. 解析参数
 * 2. 加载配置文件
 * 3. 扫描路由（.ts）
 * 4. 排序路由
 * 5. 检测路由冲突
 * 6. 全量提取 schema → schemaRegistry.loadManifest
 * 7. 生成类型文件（可选）
 * 8. 启动 server
 * 9. 执行 onReady 生命周期钩子
 * 10. 启动 watch 模式（文件变化全量重建 schema）
 *
 * start 模式（`faapi start`，生产模式）：
 * 1. 解析参数（patterns/appDir 自动指向 dist）
 * 2. 加载配置文件
 * 3. 扫描路由（.js）
 * 4. 排序路由
 * 5. 检测路由冲突
 * 6. 加载 dist/faapi-schema.js → schemaRegistry.loadManifest
 * 7. 启动 server
 * 8. 执行 onReady 生命周期钩子
 *
 * dev 和 start 共用 createServer / handleRequest / validateInput，
 * 差异仅在 schema 来源、文件类型、是否启动 watch。
 *
 * @param argv 原始 CLI 参数（含命令词 dev/start，由 parseArgs 解析）
 */
export async function startCommand(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const rootDir = process.cwd();

  // mode === 'start' → 生产模式，加载 dist 产物
  const isProd = args.mode === 'start';

  // 生产模式要求 dist/faapi-routes.js 和 dist/faapi-schema.js 存在（由 faapi build 生成）
  if (isProd) {
    const routesPath = path.resolve(rootDir, 'dist', 'faapi-routes.js');
    const schemaPath = path.resolve(rootDir, 'dist', 'faapi-schema.js');
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

  // 路由获取：start 读清单+水合，dev 扫描文件系统
  let routes: import('../router/routeTypes').RouteManifest;
  let wsRoutes: import('../router/routeTypes').WsRouteManifest;
  if (isProd) {
    // start 模式：从 dist/faapi-routes.js 读取序列化清单，水合（加载中间件）
    const routesPath = path.resolve(rootDir, 'dist', 'faapi-routes.js');
    const serialized = (await import(pathToFileURL(routesPath).href)) as import('./generateRoutes').SerializedRouteManifest;
    const hydrated = await hydrateRoutes(serialized);
    routes = hydrated.routes;
    wsRoutes = hydrated.wsRoutes;
    console.log(`- Routes loaded: ${routes.length} routes, ${wsRoutes.length} WS routes`);
  } else {
    // dev 模式：扫描文件系统
    const { patterns, appDir } = { patterns: args.patterns, appDir: args.appDir };
    const scanned = await scanRoutes(rootDir, patterns, appDir);
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

  // 加载 schema
  if (isProd) {
    // prod 模式：从 faapi-schema.js import 加载
    const schemaPath = path.resolve(rootDir, 'dist', 'faapi-schema.js');
    const manifest = await readManifestFile(schemaPath);
    // build 时 schema key 是绝对路径 + .ts（如 /abs/api/health/handler.ts），
    // 运行时 route.filePath 是相对路径 + .js + dist 前缀（如 dist/api/health/handler.js）。
    // 重写 key 使两者匹配，validateInput 才能查到。
    const remapped = remapManifestKeys(manifest, rootDir);
    schemaRegistry.loadManifest(remapped);
    console.log(`- Schema loaded: ${schemaPath}`);
  } else {
    // dev 模式：全量提取 schema 并生成校验函数（watcher 全量重建）
    const manifest = extractSchemasForRoutes(sorted, rootDir);
    schemaRegistry.loadManifest(manifest);
    console.log(`- Schema extracted: ${manifest.size} file(s)`);
  }

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

/**
 * 重写 manifest 的 filePath key，使 prd 运行时能匹配 validateInput 传入的路径
 *
 * build 时 key 形式：/abs/root/api/health/handler.ts（绝对路径 + .ts）
 * 运行时 validateInput 传入：/abs/root/dist/api/health/handler.js（绝对路径 + .js + dist 前缀）
 *
 * 转换：/abs/root/api/health/handler.ts → /abs/root/dist/api/health/handler.js
 */
function remapManifestKeys(manifest: SchemaManifest, rootDir: string): SchemaManifest {
  const remapped: SchemaManifest = new Map();
  const rootPrefix = rootDir + path.sep;
  for (const [filePath, fileSchemas] of manifest) {
    // 绝对路径 → 相对路径（api/health/handler.ts）
    let rel = filePath;
    if (filePath.startsWith(rootPrefix)) {
      rel = filePath.slice(rootPrefix.length);
    } else if (filePath.startsWith(rootDir)) {
      rel = filePath.slice(rootDir.length).replace(/^[/\\]/, '');
    }
    // .ts → .js，加 dist/ 前缀，再转回绝对路径（与 createServer 里的 absoluteFilePath 一致）
    const prodRel = `dist/${rel.replace(/\.ts$/, '.js')}`;
    const prodAbs = path.resolve(rootDir, prodRel);
    remapped.set(prodAbs, fileSchemas);
  }
  return remapped;
}
