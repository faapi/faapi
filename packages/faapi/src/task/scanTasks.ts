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
// 数字字面量含下划线分隔符（TS 惯用写法 60_000）——不支持则被截断成 60，静默错值
const NUM_LITERAL = '(\\d+(?:_\\d+)*)';
const CONCURRENCY_RE = new RegExp(`(?:^|\\n)\\s*concurrency:\\s*${NUM_LITERAL}`);
const RETRIES_RE = new RegExp(`(?:^|\\n)\\s*retries:\\s*${NUM_LITERAL}`);
const TIMEOUT_MS_RE = new RegExp(`(?:^|\\n)\\s*timeoutMs:\\s*${NUM_LITERAL}`);
const GRACE_MS_RE = new RegExp(`(?:^|\\n)\\s*graceMs:\\s*${NUM_LITERAL}`);

/** 数字字面量解析（剥离下划线分隔符——Number() 不接受 `60_000`） */
function parseNumericLiteral(raw: string): number {
  return Number(raw.replace(/_/g, ''));
}

/**
 * timeoutMs 最小值（60s）：声明 timeoutMs 的语义是"这是需要真取消的长任务"——
 * 一分钟内能跑完的任务没必要声明超时（走进程内执行，需要 deadline 自行用
 * Promise.race 实现）；且超时从派发起算、包含 worker 冷启动（线程创建 + 任务
 * 模块图加载），过小的超时会在任务做任何事之前就被取消。
 */
export const MIN_ISOLATED_TIMEOUT_MS = 60_000;

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
    const timeoutMs = TIMEOUT_MS_RE.exec(source)?.[1];
    const graceMs = GRACE_MS_RE.exec(source)?.[1];
    if (cron !== undefined) manifest.cron = cron;
    if (concurrency !== undefined) manifest.concurrency = parseNumericLiteral(concurrency);
    if (retries !== undefined) manifest.retries = parseNumericLiteral(retries);
    if (timeoutMs !== undefined) {
      const value = parseNumericLiteral(timeoutMs);
      if (value < MIN_ISOLATED_TIMEOUT_MS) {
        throw new Error(
          `[faapi] Task "${name}" timeoutMs ${value} is below the minimum ${MIN_ISOLATED_TIMEOUT_MS}ms (1 minute). ` +
            'Declaring a timeout means this is a long-running task that needs real cancellation — tasks finishing ' +
            'within a minute do not need one: remove timeoutMs to run in-process (implement your own deadline with ' +
            'Promise.race if needed), or raise it.',
        );
      }
      manifest.timeoutMs = value;
    }
    if (graceMs !== undefined) manifest.graceMs = parseNumericLiteral(graceMs);

    tasks.push(manifest);
  }

  // fast-glob 不保证文件顺序——清单顺序无语义，按任务名字母序排序
  // （与路由清单 sortRoutes 的字母序对称），保证 faapi-tasks.js 产物内容确定
  return tasks.sort((a, b) => a.name.localeCompare(b.name));
}
