import path from 'node:path';
import fs from 'node:fs/promises';
import { isInsideDir, toRealPath } from './prodPaths';

/**
 * 当前 app 的 resources 目录绑定（进程级，globalThis + Symbol.for 承载）
 *
 * 为什么用 globalThis 而非模块级变量（同 appSingleton 的取舍）：
 * ① Next.js Turbopack dev runtime 与主进程是两套 module cache，须跨实例共享；
 * ② 隔离任务的 worker wrapper 是 data URL 模块无法 import 主包，由 wrapper 内联
 * 同名 symbol key 播种（taskWorker.ts，两处字面量需一致，测试断言两边语义一致）。
 * 单 app 强制（createAppBase 检测到存活 app 即抛错）保证绑定唯一且无歧义。
 */
const ACTIVE_RESOURCES_DIR_KEY = Symbol.for('faapi.resources.dir');

function getActiveResourcesDir(): string | null {
  return (globalThis as Record<symbol, string | undefined>)[ACTIVE_RESOURCES_DIR_KEY] ?? null;
}

/**
 * 绑定/解绑当前 app 的 resources 目录（框架内部接线，不进公开导出面）
 *
 * 调用点：createAppBase 启动时绑定、app.close() 解绑、taskWorker 从快照播种
 * （内联 globalThis 写入）、createTestContext 按选项绑定（测试 handler 读资源）。
 */
export function setActiveResourcesDir(dir: string | null): void {
  if (dir === null) {
    delete (globalThis as Record<symbol, string | undefined>)[ACTIVE_RESOURCES_DIR_KEY];
  } else {
    (globalThis as Record<symbol, string | undefined>)[ACTIVE_RESOURCES_DIR_KEY] = dir;
  }
}

/**
 * 校验 relativePath 不越出 resources 目录，返回实际可读的目标绝对路径
 *
 * 两层校验：
 * 1. 字符串层——path.resolve 后必须仍在 resources 内（拦绝对路径与 `..` 穿越）
 * 2. 符号链接层——目标真实路径（realpath）必须仍在 resources 内（拦 symlink 指向
 *    目录外）；目标不存在时 toRealPath 回退原路径，缺失由 readFile 抛自然 ENOENT
 */
function resolveResourceTarget(resourcesDir: string, relativePath: string): string {
  if (typeof relativePath !== 'string' || relativePath === '') {
    throw new Error('[faapi] readResource: relativePath must be a non-empty string');
  }

  const root = toRealPath(path.resolve(resourcesDir));
  const resolved = path.resolve(root, relativePath);
  if (!isInsideDir(resolved, root)) {
    throw new Error(
      `[faapi] readResource: "${relativePath}" escapes the resources directory (absolute paths and ".." are not allowed)`,
    );
  }

  const realTarget = toRealPath(resolved);
  if (!isInsideDir(realTarget, root)) {
    throw new Error(
      `[faapi] readResource: "${relativePath}" resolves outside the resources directory via a symlink`,
    );
  }
  return realTarget;
}

/**
 * 读取当前 app 的运行时资源内容（参数为相对路径，只能读 resources 内的文件）
 *
 * 唯一读取入口：HTTP/WS handler、任务、插件、lifecycle 钩子、编程式调用全部用
 * 本函数——resources 目录在 app 启动时绑定（createAppBase），调用方不传路径根。
 * 越界校验见 resolveResourceTarget——绝对路径、`..` 穿越、符号链接逃逸均显式抛错，
 * resources 内部的合法软链不误伤。
 */
export function readResource(relativePath: string): Promise<Buffer>;
export function readResource(relativePath: string, encoding: BufferEncoding): Promise<string>;
export async function readResource(
  relativePath: string,
  encoding?: BufferEncoding,
): Promise<Buffer | string> {
  const resourcesDir = getActiveResourcesDir();
  if (!resourcesDir) {
    throw new Error(
      '[faapi] readResource: no active app in this process — resources are bound at app startup (createAppBase); testing direct-call can pass `resourcesDir` to createTestContext to bind',
    );
  }
  const target = resolveResourceTarget(resourcesDir, relativePath);
  return encoding === undefined ? fs.readFile(target) : fs.readFile(target, encoding);
}
