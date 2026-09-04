import path from 'node:path';
import fs from 'node:fs';

/** 路由源码目录（写死为 src） */
export const APP_DIR = 'src';

/** 路由文件扫描 patterns（devCommand / buildCommand / createAppCore 共用） */
export const ROUTE_PATTERNS = ['src/api/**/*.ts'];

/**
 * 把源码 filePath（src/api/hello/handler.ts）转为产物路径（<dist>/api/hello/handler.js）
 *
 * 产物结构打平 src/ 前缀：去掉 `src/`，加 dist 前缀，.ts → .js。
 * 已带 `<dist>/` 前缀的输入保持不变（幂等）。
 */
export function toProdFilePath(filePath: string, dist: string): string {
  let rel = filePath.replace(/\\/g, '/');
  // 去掉 src/ 前缀（打平产物结构）
  if (rel.startsWith('src/')) {
    rel = rel.slice(4);
  }
  const jsPath = rel.replace(/\.ts$/, '.js');
  return jsPath.startsWith(`${dist}/`) ? jsPath : `${dist}/${jsPath}`;
}

/**
 * 源文件后缀 → 产物后缀（.ts/.tsx/.jsx → .js，其余原样）
 */
export function toProdExtension(filePath: string): string {
  if (filePath.endsWith('.ts')) return filePath.slice(0, -3) + '.js';
  if (filePath.endsWith('.tsx')) return filePath.slice(0, -4) + '.js';
  if (filePath.endsWith('.jsx')) return filePath.slice(0, -4) + '.js';
  return filePath;
}

/**
 * 规范化路径为 realpath（处理 macOS /tmp → /private/tmp 等符号链接场景）
 *
 * 目录不存在时回退到原路径（不抛错），保证调用方逻辑稳定。
 */
export function toRealPath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * 判断 filePath 是否位于 dir 目录下（不依赖路径前缀字符串比较，兼容符号链接规范化差异）
 *
 * 基于 `path.relative`：相对路径不以 `..` 开头且非绝对路径时视为位于 dir 下。
 * 调用前应先用 `toRealPath` 规范化两侧路径，确保前缀一致。
 */
export function isInsideDir(filePath: string, dir: string): boolean {
  const rel = path.relative(dir, filePath);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * 源文件相对路径剥离 `src/` 前缀（打平产物结构）
 *
 * schema/tool zod.js 输出路径计算的公共步骤：
 * `src/api/hello/handler.ts` → `api/hello/handler.ts`（取目录后 join dist + zod.js）
 */
export function stripSrcPrefix(sourceFile: string): string {
  const rel = sourceFile.replace(/\\/g, '/');
  return rel.startsWith('src/') ? rel.slice(4) : rel;
}
