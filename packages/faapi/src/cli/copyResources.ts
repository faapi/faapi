import path from 'node:path';
import fs from 'node:fs';
import { isInsideDir } from '../utils/prodPaths';

/**
 * 运行时资源目录约定（源码侧，相对 rootDir）
 *
 * 放这里的文件原样复制进产物（不编译、不被任何扫描器识别），运行时经
 * `ctx.resourcesDir` / `app.resourcesDir` 定位读取。详见 copyResources.md。
 */
export const RESOURCES_DIR = 'src/resources';

/** 产物内 resources 目录名（<dist>/resources，与源码布局打平 src/ 前缀后一致） */
const RESOURCES_OUTPUT_DIR = 'resources';

/**
 * 判断绝对路径是否位于 src/resources 下（watcher 事件分流用）
 *
 * resources 文件事件走增量复制/删除，不进编译调度器；其余源码事件维持原链路。
 */
export function isResourceSourcePath(rootDir: string, absPath: string): boolean {
  return isInsideDir(absPath, path.resolve(rootDir, RESOURCES_DIR));
}

/**
 * 解析产物内 resources 根目录绝对路径
 *
 * 运行时定位入口（createAppCore / createServer / handleWsUpgrade 共用），
 * 与 createAppBase 的 dist 解析约定一致：dist 相对 rootDir。
 */
export function resolveResourcesDir(rootDir: string, dist: string): string {
  return path.resolve(rootDir, dist, RESOURCES_OUTPUT_DIR);
}

/**
 * 镜像复制 src/resources → <dist>/resources
 *
 * 先删产物目录再递归复制（dev 启动时清掉上次运行的 stale 文件；build 侧
 * emptyOutDir 已清空 dist，此删除是幂等兜底）。源目录不存在时跳过并返回
 * false——无资源目录的项目零负担，产物中也不产生 resources 目录。
 *
 * dev（devCommand 启动时）与 build（buildCommand 步骤 8）共用同一实现，
 * 差异仅由 dist 路径参数驱动。
 */
export async function copyResources(rootDir: string, dist: string): Promise<boolean> {
  const sourceDir = path.resolve(rootDir, RESOURCES_DIR);
  if (!fs.existsSync(sourceDir)) return false;

  const outDir = resolveResourcesDir(rootDir, dist);
  await fs.promises.rm(outDir, { recursive: true, force: true });
  await fs.promises.cp(sourceDir, outDir, { recursive: true });
  return true;
}

/**
 * watcher 增量复制：单个源资源文件 → 产物对应位置（自动创建父目录）
 *
 * 源文件已不存在时跳过（change 与 unlink 的竞态：删除后到达的 change 不做
 * 无用复制，产物清理由 removeResourceFile 负责）。源路径不在 src/resources
 * 下时抛错——调用方（watcher）按路径分流，越界传入视为编程错误显式失败。
 */
export async function copyResourceFile(
  rootDir: string,
  dist: string,
  absSourceFile: string,
): Promise<void> {
  const sourceDir = path.resolve(rootDir, RESOURCES_DIR);
  if (!isInsideDir(absSourceFile, sourceDir)) {
    throw new Error(`[faapi] copyResourceFile: ${absSourceFile} is not under ${RESOURCES_DIR}`);
  }
  if (!fs.existsSync(absSourceFile)) return;

  const rel = path.relative(sourceDir, absSourceFile);
  const dest = path.join(resolveResourcesDir(rootDir, dist), rel);
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  await fs.promises.cp(absSourceFile, dest);
}

/**
 * watcher 增量删除：移除产物中的对应资源文件
 *
 * 目标不存在时幂等成功（fs.rm force 语义）。源路径不在 src/resources 下时抛错，
 * 与 copyResourceFile 同一防御口径。
 */
export async function removeResourceFile(
  rootDir: string,
  dist: string,
  absSourceFile: string,
): Promise<void> {
  const sourceDir = path.resolve(rootDir, RESOURCES_DIR);
  if (!isInsideDir(absSourceFile, sourceDir)) {
    throw new Error(`[faapi] removeResourceFile: ${absSourceFile} is not under ${RESOURCES_DIR}`);
  }
  const rel = path.relative(sourceDir, absSourceFile);
  const dest = path.join(resolveResourcesDir(rootDir, dist), rel);
  await fs.promises.rm(dest, { force: true });
}
