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
import { schemaRegistry } from '../validator/schemaRegistry';
import { extractSchemasForRoutes, readManifestFile } from './generateSchema';
import { loadPlugins } from './loadPlugins';

/**
 * 判断是否为生产模式
 *
 * 满足两个条件：
 * 1. NODE_ENV=production（或 FAAPI_ENV=production）
 * 2. dist/faapi-schema.js 存在
 */
function isProductionMode(rootDir: string): boolean {
  const env = process.env.NODE_ENV ?? process.env.FAAPI_ENV ?? 'development';
  if (env !== 'production') return false;
  return fs.existsSync(path.resolve(rootDir, 'dist', 'faapi-schema.js'));
}

/**
 * 将 dev 模式的 patterns/appDir 调整为 prod 模式（指向 dist 目录）
 *
 * - patterns: .ts 后缀 → .js 后缀，加 dist/ 前缀
 * - appDir: '.' → 'dist'，'src' → 'dist/src'
 */
function adjustForProd(patterns: string[], appDir: string): { patterns: string[]; appDir: string } {
  const prodPatterns = patterns
    .map((p) => p.replace(/\.ts$/g, '.js'))
    .map((p) => {
      if (p.startsWith('dist/')) return p;
      return `dist/${p}`;
    });
  const prodAppDir = appDir === '.' ? 'dist' : `dist/${appDir}`;
  return { patterns: prodPatterns, appDir: prodAppDir };
}

/**
 * CLI 启动命令的完整流程
 *
 * dev 模式（默认）：
 * 1. 解析参数
 * 2. 加载配置文件
 * 3. 扫描路由
 * 4. 排序路由
 * 5. 检测路由冲突
 * 6. 全量提取 schema → schemaRegistry.loadManifest
 * 7. 生成类型文件（可选）
 * 8. 启动 server
 * 9. 执行 onReady 生命周期钩子
 * 10. 启动 watch 模式（文件变化全量重建 schema）
 * 11. 如果 MCP 启用，启动 MCP server
 *
 * prod 模式（NODE_ENV=production 且 dist/faapi-schema.json 存在）：
 * 1. 解析参数（patterns/appDir 自动指向 dist）
 * 2. 加载配置文件
 * 3. 扫描路由（.js 文件）
 * 4. 排序路由
 * 5. 检测路由冲突
 * 6. 加载 faapi-schema.json → schemaRegistry.loadManifest
 * 7. 启动 server
 * 8. 执行 onReady 生命周期钩子
 * 9. 如果 MCP 启用，启动 MCP server
 *
 * dev 和 prod 共用 createServer / handleRequest / validateInput，
 * 差异仅在 schema 来源、文件类型、是否启动 watch。
 */
export async function startCommand(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const rootDir = process.cwd();

  // 判断模式
  const isProd = isProductionMode(rootDir);

  // 调整 patterns/appDir（prod 模式指向 dist）
  const { patterns, appDir } = isProd
    ? adjustForProd(args.patterns, args.appDir)
    : { patterns: args.patterns, appDir: args.appDir };

  if (isProd) {
    console.log('- Production mode');
  } else {
    // 标记 dev 模式
    process.env.__FAAPI_DEV__ = '1';
    console.log('- Development mode');
  }

  // 加载配置文件
  const config = await loadConfig(rootDir, args.config);
  if (config) {
    console.log('- Config loaded');
  }

  // 扫描路由（HTTP + WebSocket）
  const { routes, wsRoutes } = await scanRoutes(rootDir, patterns, appDir);
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
    schemaRegistry.loadManifest(manifest);
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
