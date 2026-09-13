import fg from 'fast-glob';
import path from 'node:path';
import fs from 'node:fs';
import type { TaskManifest } from './taskTypes';

/**
 * 任务扫描 patterns（框架约定，非用户可配置项）
 *
 * 与路由的 src/api、tool 的 src/tools 对称——任务文件约定放在
 * `src/tasks` 下任意层级子目录的 task.ts（与 handler.ts 同构的一文件一任务约定）。
 */
export const TASK_PATTERNS = ['src/tasks/**/task.ts'];

/**
 * 任务文件名约定（只识别 task.ts，与路由 handler.ts 对称）
 */
const TASK_FILENAME = 'task.ts';

/**
 * meta 字段提取（零 import——读源码正则提取字面量，与 scanRoutes 提取方法名同策略）
 *
 * 只匹配对象字面量中的简单字面量形式（字符串/数字），不追求完整表达式求值——
 * meta 是静态声明，动态计算的 cron/并发数不支持（显式约束，不静默降级）。
 */
const CRON_RE = /(?:^|\n)\s*cron:\s*['"`]([^'"`\n]+)['"`]/;
const CONCURRENCY_RE = /(?:^|\n)\s*concurrency:\s*(\d+)/;
const RETRIES_RE = /(?:^|\n)\s*retries:\s*(\d+)/;

/**
 * 从源码相对路径推导任务名
 *
 * `src/tasks/send-email/task.ts` → `'send-email'`
 * `src/tasks/a/b/task.ts` → `'a.b'`
 */
function filePathToTaskName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const match = normalized.match(/(?:^|\/)tasks\/(.+)\/task\.ts$/);
  if (!match) {
    throw new Error(`[faapi] Invalid task file path: ${filePath}`);
  }
  return match[1]!.split('/').join('.');
}

/**
 * 扫描 tasks 目录，生成任务清单
 *
 * Vite 风格：只读源码 + 正则提取 meta 字面量，不 import 任务模块。
 * 任务模块的编译与加载延后到运行时（队列派发时 import 产物路径）。
 *
 * 重名检测：不同文件推导出同名任务时抛错。
 *
 * @param rootDir 项目根目录
 * @param patterns glob patterns（匹配 src/tasks 下的 task.ts）
 */
export async function scanTasks(rootDir: string, patterns: string[]): Promise<TaskManifest[]> {
  const files = await fg(patterns, {
    cwd: rootDir,
    onlyFiles: true,
    absolute: false,
  });

  const tasks: TaskManifest[] = [];
  const seen = new Map<string, string>();

  for (const file of files) {
    const normalizedFile = file.replace(/\\/g, '/');
    const fileName = path.posix.basename(normalizedFile);

    if (fileName !== TASK_FILENAME) {
      continue;
    }

    const absPath = path.resolve(rootDir, normalizedFile);
    const source = await fs.promises.readFile(absPath, 'utf8').catch(() => '');
    const name = filePathToTaskName(normalizedFile);

    const prevFile = seen.get(name);
    if (prevFile) {
      throw new Error(
        `Task conflict: "${name}" declared in both ${prevFile} and ${normalizedFile}`,
      );
    }
    seen.set(name, normalizedFile);

    const manifest: TaskManifest = { name, filePath: normalizedFile };
    const cron = CRON_RE.exec(source)?.[1];
    const concurrency = CONCURRENCY_RE.exec(source)?.[1];
    const retries = RETRIES_RE.exec(source)?.[1];
    if (cron !== undefined) manifest.cron = cron;
    if (concurrency !== undefined) manifest.concurrency = Number(concurrency);
    if (retries !== undefined) manifest.retries = Number(retries);

    tasks.push(manifest);
  }

  return tasks;
}
