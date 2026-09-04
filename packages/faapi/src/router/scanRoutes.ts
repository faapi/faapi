import fg from 'fast-glob';
import path from 'node:path';
import fs from 'node:fs';
import type { RouteManifest, WsRouteManifest } from './routeTypes';
import { HTTP_METHODS } from './constants';
import { filePathToUrlPath, extractParamNames, isCatchAllSegment } from './parseRouteFile';
import { loadMergedMiddlewares } from '../middleware/loadMiddlewares';
import type { FaapiMiddleware } from '../middleware/middlewareTypes';
import type { InjectorMap } from '../middleware/injectorTypes';
import { toProdFilePath } from '../utils/prodPaths';

/**
 * 匹配源码中导出的 HTTP 方法或 WS 函数
 *
 * 支持：
 * - `export function GET() {}`
 * - `export async function POST() {}`
 * - `export const GET = () => {}` / `export const GET = async () => {}`
 * - `export function WS() {}`
 *
 * 不通过运行时 import 提取方法名，避免启动时全量加载 handler 模块（Vite 风格：
 * 路由发现与 handler 加载解耦，handler.js 按需编译/导入）。
 */
const HTTP_OR_WS_EXPORT_RE = new RegExp(
  String.raw`export\s+(?:async\s+)?(?:function\s+|const\s+)(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|WS)\b`,
  'g',
);

/**
 * 从源码内容中提取所有 HTTP 方法 + WS 导出名（去重）
 */
function extractExportsFromSource(source: string): Set<string> {
  const names = new Set<string>();
  let match: RegExpExecArray | null;
  HTTP_OR_WS_EXPORT_RE.lastIndex = 0;
  while ((match = HTTP_OR_WS_EXPORT_RE.exec(source)) !== null) {
    names.add(match[1]!);
  }
  return names;
}

/**
 * 从路由文件所在目录向上逐级查找 middlewares.ts（源码），
 * 返回从根到路由目录的中间件文件**绝对路径列表**（不加载模块）。
 *
 * 设计意图：scanRoutes 不再启动时全量 import middlewares.js，仅收集路径；
 * 实际的中间件加载延后到 hydrateRoutes / 请求阶段（与 prod 的 hydrateRoutes 一致）。
 * 这样 dev 启动时 zero import，启动速度接近 Vite。
 *
 * 路径选择规则（与 generateRoutes.extractMiddlewarePaths 一致）：
 * - dist 传入：返回**产物** middlewares.js 绝对路径（打平 src/ 前缀，存在性检查源码 .ts）
 * - dist 不传：返回**源码** middlewares.ts/.js 绝对路径（兼容无 dist 的旧调用方，如 testServer）
 *
 * @param routeFilePath 源码相对路径（如 src/api/hello/handler.ts）
 * @param rootDir 项目根目录
 * @param dist 产物目录（dist 或 .faapi），不传则返回源码路径
 * @returns 中间件文件绝对路径列表（根在前，路由目录在后）；空数组表示无中间件
 */
function collectMiddlewarePaths(routeFilePath: string, rootDir: string, dist?: string): string[] {
  const routeDir = path.dirname(routeFilePath);
  const resolvedRoot = path.resolve(rootDir);

  const paths: string[] = [];
  let currentDir = path.resolve(rootDir, routeDir);
  while (true) {
    if (dist) {
      // 产物模式：检查源码 middlewares.ts 是否存在，返回产物 middlewares.js 绝对路径
      const mwTsPath = path.join(currentDir, 'middlewares.ts');
      const mwJsPath = path.join(currentDir, 'middlewares.js');
      const absTsPath = path.resolve(rootDir, mwTsPath);
      const absJsPath = path.resolve(rootDir, mwJsPath);
      const absMwPath = fs.existsSync(absTsPath)
        ? absTsPath
        : fs.existsSync(absJsPath)
          ? absJsPath
          : null;
      if (absMwPath) {
        // 转为产物形式绝对路径（打平 src/ 前缀，加 dist 前缀）
        const relMwPath = path.relative(rootDir, absMwPath);
        const prodAbsPath = path.resolve(rootDir, toProdFilePath(relMwPath, dist));
        paths.push(prodAbsPath);
      }
    } else {
      // 源码模式（testServer / 单元测试用）：直接返回源码 middlewares.ts/.js 绝对路径
      for (const ext of ['.ts', '.js']) {
        const mwPath = path.join(currentDir, `middlewares${ext}`);
        const absMwPath = path.resolve(rootDir, mwPath);
        if (fs.existsSync(absMwPath)) {
          paths.push(absMwPath);
          break;
        }
      }
    }
    if (currentDir === resolvedRoot) break;
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }

  // paths 是从路由目录向上收集的，需反转为根在前
  paths.reverse();
  return paths;
}

/**
 * 按路径列表加载并合并中间件（根在前，路由目录在后）
 *
 * 已移至 `middleware/loadMiddlewares.ts` 的 `loadMergedMiddlewares`，
 * scanRoutes 不再预加载中间件（dist 模式只收集路径，请求阶段按需加载）。
 */

/**
 * 扫描 api 目录，同时生成 HTTP 路由清单和 WebSocket 路由清单
 *
 * **Vite 风格**：启动时只读源码 + 正则提取方法名，不 import handler.js / middlewares.js。
 * 中间件改为"收集路径"，加载延后到 hydrateRoutes / 请求阶段。
 *
 * 路由文件格式：handler.ts，导出 HTTP 方法名作为 handler，也可导出 `WS` 函数声明 WebSocket 路由
 * ```ts
 * // api/user/handler.ts
 * export function GET() { return { list: [] } }
 * export function POST(body: any) { return { created: true } }
 *
 * // WebSocket 路由：导出 WS 函数
 * export function WS(ctx: WsContext) {
 *   return { onMessage(ws, msg) { ws.send(`echo: ${msg}`) } };
 * }
 * ```
 * 一个 handler.ts 可同时导出 HTTP 方法（GET/POST...）和 WS 函数，
 * 分别生成 HTTP RouteRecord 和 WsRouteRecord。
 *
 * **中间件加载策略**：
 * - dev/prod（dist 传入）：scanRoutes 仅收集 middlewarePaths，不加载模块；
 *   由 hydrateRoutes（prod）或 dev 启动流程加载
 * - 无 dist 模式（testServer / 单元测试）：scanRoutes 直接加载中间件并塞入 route.middlewares
 *   （保持向后兼容，避免破坏现有测试）
 *
 * @param rootDir 项目根目录
 * @param patterns glob patterns（源码 .ts 路径，如 src/api 下所有 .ts）
 * @param dist 产物目录（dist 或 .faapi）。传入时 scanRoutes 不 import 任何模块；
 *                不传时 import 源码 .ts（旧模式，需要 tsx，仅 testServer/单测使用）。
 */
export async function scanRoutes(
  rootDir: string,
  patterns: string[],
  dist?: string,
): Promise<{ routes: RouteManifest; wsRoutes: WsRouteManifest }> {
  const files = await fg(patterns, {
    cwd: rootDir,
    onlyFiles: true,
    absolute: false,
  });

  const routes: RouteManifest = [];
  const wsRoutes: WsRouteManifest = [];

  for (const file of files) {
    const normalizedFile = file.replace(/\\/g, '/');
    const fileName = normalizedFile.split('/').pop()!;

    // 处理 handler.{ts,js} — API 路由 + WebSocket 路由
    // dev/build 模式扫源码 .ts（dist 传入），start 模式扫产物 .js（由 hydrateRoutes 处理）
    if (fileName === 'handler.ts' || fileName === 'handler.js') {
      const absPath = path.resolve(rootDir, normalizedFile);
      const urlPath = filePathToUrlPath(normalizedFile);
      const paramNames = extractParamNames(urlPath);
      const isDynamic = paramNames.length > 0;
      const isCatchAll = normalizedFile.split('/').some(isCatchAllSegment);

      // 中间件：dist 模式只收集路径（按需加载），无 dist 模式直接加载
      let middlewarePaths: string[] | undefined;
      let middlewareBundle: { middlewares: FaapiMiddleware[]; injectors: InjectorMap } | undefined;
      if (dist) {
        // dev/prod 模式：仅收集路径，请求阶段按需加载（Vite 风格）
        middlewarePaths = collectMiddlewarePaths(normalizedFile, rootDir, dist);
      } else {
        // 无 dist 模式（testServer/单测）：直接加载源码中间件
        const mwPaths = collectMiddlewarePaths(normalizedFile, rootDir);
        middlewareBundle = await loadMergedMiddlewares(mwPaths);
      }

      // 提取导出名（HTTP 方法 + WS）：读源码 + 正则匹配，不 import 模块
      const source = await fs.promises.readFile(absPath, 'utf8').catch(() => '');
      const exportNames = extractExportsFromSource(source);
      const methods = HTTP_METHODS.filter((m) => exportNames.has(m));

      for (const method of methods) {
        routes.push({
          method,
          urlPath,
          filePath: normalizedFile,
          paramNames,
          isDynamic,
          isCatchAll: isCatchAll || undefined,
          middlewarePaths,
          middlewares: middlewareBundle?.middlewares,
          injectors: middlewareBundle?.injectors,
        });
      }

      // WS 导出
      if (exportNames.has('WS')) {
        wsRoutes.push({
          urlPath,
          filePath: normalizedFile,
          paramNames,
          isDynamic,
          isCatchAll: isCatchAll || undefined,
          middlewarePaths,
          middlewares: middlewareBundle?.middlewares,
          injectors: middlewareBundle?.injectors,
        });
      }
      continue;
    }
  }

  return { routes, wsRoutes };
}
