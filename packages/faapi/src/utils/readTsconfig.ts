import ts from 'typescript';
import path from 'node:path';
import fs from 'node:fs';

/**
 * tsconfig paths 别名配置（已规范化为绝对路径）
 *
 * - baseUrl：绝对路径（无 baseUrl 时为 tsconfig 所在目录）
 * - paths：pattern -> 绝对路径数组（保留 * 通配符，供 resolveAlias 替换）
 */
export interface TsconfigPathsConfig {
  baseUrl: string;
  paths: Record<string, string[]>;
}

/**
 * 读取项目 tsconfig.json，提取 baseUrl + paths，规范化为绝对路径配置
 *
 * 用 TypeScript Compiler API 解析（处理注释、extends 合并）。
 * 仅读取 rootDir 下的 tsconfig.json，不向上递归查找。
 * 无 paths 时返回 null。
 *
 * 按 tsconfig mtime 缓存：每次编译（watcher 每轮重建、每次首请求按需编译）都会
 * 调本函数，Compiler API 的 readConfigFile + extends 链合并在长 extends 链项目上
 * 开销可观。tsconfig 变化时 mtime 变化 → 缓存自动失效，无需手动清理。
 */
interface TsconfigCacheEntry {
  mtimeMs: number;
  config: TsconfigPathsConfig | null;
}
const tsconfigCache = new Map<string, TsconfigCacheEntry>();

export function readTsconfig(rootDir: string): TsconfigPathsConfig | null {
  const tsconfigPath = path.resolve(rootDir, 'tsconfig.json');
  if (!fs.existsSync(tsconfigPath)) return null;

  // mtime 缓存：tsconfig 未变化时直接复用解析结果
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(tsconfigPath).mtimeMs;
  } catch {
    return null;
  }
  const cached = tsconfigCache.get(tsconfigPath);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.config;
  }

  const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (configFile.error || !configFile.config) return null;

  // parseJsonConfigFileContent 处理 extends 合并、解析 baseUrl 为绝对路径
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, rootDir);

  // baseUrl：parseJsonConfigFileContent 已解析为绝对路径；未设置时回退到 rootDir
  const baseUrl = parsed.options.baseUrl ?? rootDir;

  const rawPaths = parsed.options.paths;
  const config: TsconfigPathsConfig | null = rawPaths
    ? (() => {
        // paths 目标：原始字符串相对 baseUrl，解析为绝对路径（保留 *）
        const paths: Record<string, string[]> = {};
        for (const [pattern, targets] of Object.entries(rawPaths)) {
          paths[pattern] = targets.map((t) => path.resolve(baseUrl, t));
        }
        return { baseUrl, paths };
      })()
    : null;

  tsconfigCache.set(tsconfigPath, { mtimeMs, config });
  return config;
}
