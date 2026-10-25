import fg from 'fast-glob';
import path from 'node:path';
import fs from 'node:fs';
import type { TaskManifest } from './taskTypes';
import { DIR_SEGMENT_PATTERN } from '../naming/nameRules';

/**
 * 任务扫描 patterns（框架约定，非用户可配置项）
 *
 * 与路由的 src/api、tool 的 src/tools 对称——任务文件约定放在 `src/tasks` 下任意
 * 层级子目录，**文件名即执行语义**（两种声明 API）：
 * - `task.ts` → 进程内任务（`mode: 'inline'`，TaskContext，零开销默认路径）
 * - `worker.ts` → 隔离任务（`mode: 'isolated'`，IsolatedTaskContext，真终止取消）
 *
 * 与 handler.ts 同构的一文件一任务约定；两种文件同目录并存构建期报错。
 */
export const TASK_PATTERNS = ['src/tasks/**/task.ts', 'src/tasks/**/worker.ts'];

/**
 * 进程内任务文件名约定（task.ts）
 */
const TASK_FILENAME = 'task.ts';

/**
 * 隔离任务文件名约定（worker.ts）
 */
const WORKER_FILENAME = 'worker.ts';

/**
 * meta 字段提取（零 import——读源码正则提取字面量，与 scanRoutes 提取方法名同策略）
 *
 * 只匹配对象字面量中的简单字面量形式（字符串/数字），不追求完整表达式求值——
 * meta 是静态声明，动态计算的 cron/并发数不支持（显式约束，不静默降级）。
 */
// cron 字符串字面量提取——闭合引号后同款值后边界（与 NUM_BOUNDARY 统一口径）：
// `'0 3 * * *' + suffix` 拼接表达式不能被引号前缀静默截取（交给字面量守卫显式抛错）；
// 行尾注释放行（`cron: '0 3 * * *' // nightly` 不误伤）
const CRON_RE = /(?:^|\n)\s*cron:\s*['"`]([^'"`\n]+)['"`](?=\s*(?:\/\/|\/\*|,|\}|\n|$))/;
// 数字字面量含下划线分隔符（TS 惯用写法 60_000）——不支持则被截断成 60，静默错值
const NUM_LITERAL = '(\\d+(?:_\\d+)*)';
// 数字字段统一后边界：值后必须紧跟 `,` / `}` / 换行 / 行尾注释（`//`、`/*`）/ 结尾。
// `30 * 60_000` 这类表达式不能被前导字面量静默截取（意图 30 分钟，截取 30 是静默
// 错值——交给字面量守卫显式抛错）；行尾注释放行，`timeoutMs: 60_000 // one minute`
// 风格不误伤（cron 字符串字段在 CRON_RE 内联同款边界，六个 meta 字段口径统一，
// 见 scanTasks.md）
const NUM_BOUNDARY = '(?=\\s*(?://|/\\*|,|\\}|\\n|$))';
const CONCURRENCY_RE = new RegExp(`(?:^|\\n)\\s*concurrency:\\s*${NUM_LITERAL}${NUM_BOUNDARY}`);
const RETRIES_RE = new RegExp(`(?:^|\\n)\\s*retries:\\s*${NUM_LITERAL}${NUM_BOUNDARY}`);
const TIMEOUT_MS_RE = new RegExp(`(?:^|\\n)\\s*timeoutMs:\\s*${NUM_LITERAL}${NUM_BOUNDARY}`);
const GRACE_MS_RE = new RegExp(`(?:^|\\n)\\s*graceMs:\\s*${NUM_LITERAL}${NUM_BOUNDARY}`);
const MAX_OLD_GEN_RE = new RegExp(
  `(?:^|\\n)\\s*maxOldGenerationSizeMb:\\s*${NUM_LITERAL}${NUM_BOUNDARY}`,
);

/** 数字字面量 meta 字段（字面量守卫的宽松检测清单，cron 单列为字符串字面量） */
const NUMERIC_META_FIELDS = [
  'concurrency',
  'retries',
  'timeoutMs',
  'graceMs',
  'maxOldGenerationSizeMb',
] as const;
const STRING_META_FIELDS = ['cron'] as const;
const ALL_META_FIELDS: readonly string[] = [...NUMERIC_META_FIELDS, ...STRING_META_FIELDS];

/**
 * 宽松检测源码中声明的 meta 字段名（含声明但值非法的情况）
 *
 * 按非注释行内的 `字段名:` 检测声明（不锚行首，单行对象写法也能命中）。
 * 行注释（`// timeoutMs: ...` 示例）与块注释行（`*` / `/*` 开头、块注释终止符
 * 结尾）跳过不误报；残余误报面为单行块注释内嵌 meta 形样的文本——报错信息含
 * 此提示，改写注释即可解除（零 import 扫描不做完整注释解析）。
 */
function detectDeclaredMetaFields(source: string): Set<string> {
  const declared = new Set<string>();
  for (const line of source.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('//')) continue;
    if (trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.endsWith('*/')) continue;
    for (const field of ALL_META_FIELDS) {
      if (new RegExp(`\\b${field}\\s*:`).test(trimmed)) declared.add(field);
    }
  }
  return declared;
}

/**
 * meta 字面量守卫：找「声明了但严格字面量正则没提取到」的字段
 *
 * 严格正则以行首锚提取值，抓不到单行对象写法（`export const task = { timeoutMs: 30 * 60_000 }`）
 * 和动态值——识别不了就忽略是静默降级：隔离任务的 timeoutMs 丢失会让任务在无执行
 * 预算的状态下派发（队列系统默认限值强杀仍在跑的任务后重投）。这里用宽松检测声明，
 * 与严格提取结果求差集，差集字段由调用方构建期抛错。
 */
function detectIgnoredMetaFields(source: string, strictHit: Record<string, boolean>): string[] {
  const declared = detectDeclaredMetaFields(source);
  return ALL_META_FIELDS.filter((field) => declared.has(field) && !strictHit[field]);
}

/**
 * 守卫命中即构建期抛错（逐字段列出后果与修复指引，不降级为警告后忽略）
 */
function throwIgnoredMetaFields(name: string, fields: string[]): void {
  if (fields.length === 0) return;
  const details = fields.map((field) => {
    if (STRING_META_FIELDS.includes(field as (typeof STRING_META_FIELDS)[number])) {
      return (
        `"${field}": value is not a string literal — the declaration would be ignored and ` +
        `the task would not be cron-scheduled. Use a quoted literal (cron: '0 3 * * *'), ` +
        'not an expression or a dynamic value.'
      );
    }
    const consequence =
      field === 'timeoutMs'
        ? ' — the declaration would be ignored and the isolated task would be dispatched without its execution budget'
        : ' — the declaration would be ignored';
    return (
      `"${field}": value is not a numeric literal${consequence}. Only literal values are ` +
      'recognized (underscores allowed, e.g. 1_800_000); expressions like 30 * 60_000 or ' +
      'dynamic values are not supported.'
    );
  });
  throw new Error(
    `[faapi] Task "${name}" declares meta field(s) with non-literal values:\n  ` +
      `${details.join('\n  ')}\n` +
      'Meta values are extracted from source code without importing it, so only literals are recognized. ' +
      'If a matched line is inside a block comment (e.g. a single-line /* ... */ comment containing a ' +
      'meta-like declaration), rewrite the comment so it does not look like a meta declaration.',
  );
}

/** 数字字面量解析（剥离下划线分隔符——Number() 不接受 `60_000`） */
function parseNumericLiteral(raw: string): number {
  return Number(raw.replace(/_/g, ''));
}

/**
 * timeoutMs 最小值（60s）：隔离任务的语义是"这是需要真取消的长任务"——
 * 一分钟内能跑完的任务没必要隔离（走 task.ts 进程内执行，需要 deadline 自行用
 * Promise.race 实现）；且超时从派发起算、包含 worker 冷启动（线程创建 + 任务
 * 模块图加载），过小的超时会在任务做任何事之前就被取消。
 */
export const MIN_ISOLATED_TIMEOUT_MS = 60_000;

/**
 * timeoutMs 最大值（23h）：pg-boss 驱动按 `ceil((timeoutMs + graceMs) / 1000) + 缓冲`
 * 给任务设 expire_in（执行预算——预算内 pg-boss 不会把在跑任务判失联重投），而
 * pg-boss 12.28 之前的版本断言 expireIn 严格小于 24h（12.28 起放宽到允许恰好 24h）。
 * 23h 上限兼容全部 pg-boss 12 小版本并保持跨驱动统一预算口径，为 expire 预算留出
 * 约 1h 余量，任何合理的 graceMs 都安全。单任务执行预算超过一天应拆为可恢复的
 * 分段流水线（自行落进度、多次入队续跑），或改用 bullmq 驱动（Redis 无此上限）。
 */
export const MAX_ISOLATED_TIMEOUT_MS = 23 * 60 * 60_000;

/**
 * maxOldGenerationSizeMb 最小值（16MB）：worker 堆上限低于 16MB 时 V8 在任务模块
 * 加载阶段就会 OOM（ERR_WORKER_OUT_OF_MEMORY）——任务做任何事之前即被杀，声明了
 * 等于没声明。下限只挡明显失配的声明，不设上限（业务按机器内存自行量体裁衣；
 * 全局并发预算见 config.task.maxIsolatedWorkers，两者配合兜住 CPU/内存密集场景）
 */
export const MIN_WORKER_MAX_OLD_GEN_MB = 16;

/**
 * 从源码相对路径推导任务名
 *
 * `src/tasks/send-email/task.ts` → `'send-email'`
 * `src/tasks/a/b/worker.ts` → `'a_b'`（两种声明文件同规则）
 *
 * 目录段含非法字符时抛错（含路径与改名指引），不静默净化——白名单保证
 * 「目录路径 → 任务名」映射单射，重名冲突只剩同目录双文件一种形态。
 */
function filePathToTaskName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const match = normalized.match(/(?:^|\/)tasks\/(.+)\/(?:task|worker)\.ts$/);
  if (!match) {
    throw new Error(`[faapi] Invalid task file path: ${filePath}`);
  }
  const segments = match[1]!.split('/');
  for (const segment of segments) {
    if (!DIR_SEGMENT_PATTERN.test(segment)) {
      throw new Error(
        `Invalid task directory segment "${segment}" in "${normalized}": ` +
          `task directory names allow a-z A-Z 0-9 '-' only ('_' is reserved as the nesting separator, ` +
          `'.' is not allowed — task names follow the agent / tool directory naming rule) — rename the directory`,
      );
    }
  }
  return segments.join('_');
}

/**
 * 扫描 tasks 目录，生成任务清单
 *
 * Vite 风格：只读源码 + 正则提取 meta 字面量，不 import 任务模块。
 * 任务模块的编译与加载延后到运行时（队列派发时 import 产物路径）。
 *
 * 文件名即执行语义：task.ts → inline（进程内），worker.ts → isolated（隔离，
 * timeoutMs 必填）。进程内任务声明 timeoutMs/graceMs 构建期报错（迁移指引：
 * 改名 worker.ts），同目录两种文件并存同样报错。
 *
 * 重名检测：不同文件推导出同名任务时抛错。
 *
 * @param rootDir 项目根目录
 * @param patterns glob patterns（匹配 src/tasks 下的 task.ts / worker.ts）
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

    if (fileName !== TASK_FILENAME && fileName !== WORKER_FILENAME) {
      continue;
    }

    const absPath = path.resolve(rootDir, normalizedFile);
    const source = await fs.promises.readFile(absPath, 'utf8').catch(() => '');
    const name = filePathToTaskName(normalizedFile);
    const mode: 'inline' | 'isolated' = fileName === WORKER_FILENAME ? 'isolated' : 'inline';

    const prevFile = seen.get(name);
    if (prevFile) {
      // 两种文件并存的常见形态是同目录 task.ts + worker.ts——消息按文件名字母序
      // 排列保证确定性
      const [a, b] = [prevFile, normalizedFile].sort();
      throw new Error(`Task conflict: "${name}" declared in both ${a} and ${b}`);
    }
    seen.set(name, normalizedFile);

    const cron = CRON_RE.exec(source)?.[1];
    const concurrency = CONCURRENCY_RE.exec(source)?.[1];
    const retries = RETRIES_RE.exec(source)?.[1];
    const timeoutMs = TIMEOUT_MS_RE.exec(source)?.[1];
    const graceMs = GRACE_MS_RE.exec(source)?.[1];
    const maxOldGenerationSizeMb = MAX_OLD_GEN_RE.exec(source)?.[1];
    const declared = detectDeclaredMetaFields(source);

    // 两种声明 API 的 meta 收窄校验（优先于字面量守卫——迁移指引比"值非法"更有用）
    if (
      mode === 'inline' &&
      (declared.has('timeoutMs') ||
        declared.has('graceMs') ||
        declared.has('maxOldGenerationSizeMb'))
    ) {
      throw new Error(
        `[faapi] Task "${name}" (task.ts) declares timeoutMs/graceMs/maxOldGenerationSizeMb — in-process tasks (task.ts) ` +
          'do not take timeout or heap settings. Execution path is decided by the declaration file, not by ' +
          'timeoutMs or maxOldGenerationSizeMb: to run isolated with real cancellation and a worker heap cap, ' +
          'rename the file to worker.ts and declare a required timeoutMs (60s–23h); for an in-process deadline, ' +
          'race your work against a timer with Promise.race. ' +
          'Remove timeoutMs/graceMs/maxOldGenerationSizeMb from task.ts.',
      );
    }
    // 声明了 timeoutMs 但严格提取不到（单行对象写法/表达式/动态值）时不报必填错——
    // 交给字面量守卫给出"值无法识别"的精确指引；仅"完全未声明"报必填错
    if (mode === 'isolated' && timeoutMs === undefined && !declared.has('timeoutMs')) {
      throw new Error(
        `[faapi] Task "${name}" (worker.ts) must declare timeoutMs (60s–23h) — isolated execution ` +
          'exists to really cancel long-running tasks; an isolated task without an execution budget ' +
          'cannot be cancelled by timeout. Declare it as a numeric literal (underscores allowed, ' +
          'e.g. timeoutMs: 600_000).',
      );
    }

    const strictHit: Record<string, boolean> = {
      cron: cron !== undefined,
      concurrency: concurrency !== undefined,
      retries: retries !== undefined,
      timeoutMs: timeoutMs !== undefined,
      graceMs: graceMs !== undefined,
      maxOldGenerationSizeMb: maxOldGenerationSizeMb !== undefined,
    };
    throwIgnoredMetaFields(name, detectIgnoredMetaFields(source, strictHit));

    const manifest: TaskManifest = { name, filePath: normalizedFile, mode };
    if (cron !== undefined) manifest.cron = cron;
    if (concurrency !== undefined) manifest.concurrency = parseNumericLiteral(concurrency);
    if (retries !== undefined) manifest.retries = parseNumericLiteral(retries);
    if (timeoutMs !== undefined) {
      const value = parseNumericLiteral(timeoutMs);
      if (value < MIN_ISOLATED_TIMEOUT_MS) {
        throw new Error(
          `[faapi] Task "${name}" timeoutMs ${value} is below the minimum ${MIN_ISOLATED_TIMEOUT_MS}ms (1 minute). ` +
            'Isolated execution exists for tasks that need real cancellation — tasks finishing within ' +
            'a minute do not need one: switch back to task.ts to run in-process (implement your own ' +
            'deadline with Promise.race if needed), or raise it.',
        );
      }
      if (value > MAX_ISOLATED_TIMEOUT_MS) {
        throw new Error(
          `[faapi] Task "${name}" timeoutMs ${value} exceeds the maximum ${MAX_ISOLATED_TIMEOUT_MS}ms (23 hours). ` +
            'The pg-boss driver budgets expire_in from timeoutMs (execution budget preventing mid-run re-delivery), ' +
            'and pg-boss versions before 12.28 assert expire_in strictly below 24h — the 23h cap keeps every ' +
            'driver and pg-boss version on a single bound. ' +
            'Split the work into a resumable pipeline (persist progress, enqueue the next stage), or use the ' +
            'bullmq driver (Redis has no such cap).',
        );
      }
      manifest.timeoutMs = value;
    }
    if (graceMs !== undefined) manifest.graceMs = parseNumericLiteral(graceMs);
    if (maxOldGenerationSizeMb !== undefined) {
      const value = parseNumericLiteral(maxOldGenerationSizeMb);
      if (value < MIN_WORKER_MAX_OLD_GEN_MB) {
        throw new Error(
          `[faapi] Task "${name}" maxOldGenerationSizeMb ${value} is below the minimum ${MIN_WORKER_MAX_OLD_GEN_MB} MB. ` +
            'A worker heap cap below 16 MB gets killed by V8 during module loading, before the task can do ' +
            'any work. Raise it (memory-heavy workers typically use 512–2048), or remove the field to ' +
            'inherit the host process default (no cap).',
        );
      }
      manifest.maxOldGenerationSizeMb = value;
    }

    tasks.push(manifest);
  }

  // fast-glob 不保证文件顺序——清单顺序无语义，按任务名字母序排序
  // （与路由清单 sortRoutes 的字母序对称），保证 faapi-tasks.js 产物内容确定
  return tasks.sort((a, b) => a.name.localeCompare(b.name));
}
