import fg from 'fast-glob';
import path from 'node:path';
import fs from 'node:fs';
import type { TaskManifest } from './taskTypes';
import { DIR_SEGMENT_PATTERN } from '../naming/nameRules';

/**
 * 任务扫描 patterns（框架约定，非用户可配置项）
 *
 * 与路由的 src/api、tool 的 src/tools 对称——任务文件约定放在 `src/tasks` 下任意
 * 层级子目录（task.ts 进程内声明）：
 *
 * 与 handler.ts 同构的一文件一任务约定。
 */
export const TASK_PATTERNS = ['src/tasks/**/task.ts'];

/**
 * 进程内任务文件名约定（task.ts）
 */
const TASK_FILENAME = 'task.ts';

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
// 错值——交给字面量守卫显式抛错）；行尾注释放行，`retries: 2 // twice`
// 风格不误伤（cron 字符串字段在 CRON_RE 内联同款边界，meta 字段口径统一，
// 见 scanTasks.md）
const NUM_BOUNDARY = '(?=\\s*(?://|/\\*|,|\\}|\\n|$))';
const CONCURRENCY_RE = new RegExp(`(?:^|\\n)\\s*concurrency:\\s*${NUM_LITERAL}${NUM_BOUNDARY}`);
const RETRIES_RE = new RegExp(`(?:^|\\n)\\s*retries:\\s*${NUM_LITERAL}${NUM_BOUNDARY}`);

/** 数字字面量 meta 字段（字面量守卫的宽松检测清单，cron 单列为字符串字面量） */
const NUMERIC_META_FIELDS = ['concurrency', 'retries'] as const;
const STRING_META_FIELDS = ['cron'] as const;
const ALL_META_FIELDS: readonly string[] = [...NUMERIC_META_FIELDS, ...STRING_META_FIELDS];

/**
 * 宽松检测源码中声明的 meta 字段名（含声明但值非法的情况）
 *
 * 按非注释行内的 `字段名:` 检测声明（不锚行首，单行对象写法也能命中）。
 * 行注释（`// retries: ...` 示例）与块注释行（`*` / `/*` 开头、块注释终止符
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
 * 严格正则以行首锚提取值，抓不到单行对象写法（`export const task = { retries: 2 }` 单行形态）
 * 和动态值——识别不了就忽略是静默降级：任务的 retries 丢失会让失败任务不重试。
 * 这里用宽松检测声明，与严格提取结果求差集，差集字段由调用方构建期抛错。
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
    return (
      `"${field}": value is not a numeric literal — the declaration would be ignored. Only literal values are ` +
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
 * 从源码相对路径推导任务名
 *
 * `src/tasks/send-email/task.ts` → `'send-email'`
 *
 * 目录段含非法字符时抛错（含路径与改名指引），不静默净化——白名单保证
 * 「目录路径 → 任务名」映射单射，重名冲突只剩同目录双文件一种形态。
 */
function filePathToTaskName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const match = normalized.match(/(?:^|\/)tasks\/(.+)\/task\.ts$/);
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
 * 任务在进程内执行。
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
      const [a, b] = [prevFile, normalizedFile].sort();
      throw new Error(`Task conflict: "${name}" declared in both ${a} and ${b}`);
    }
    seen.set(name, normalizedFile);

    const cron = CRON_RE.exec(source)?.[1];
    const concurrency = CONCURRENCY_RE.exec(source)?.[1];
    const retries = RETRIES_RE.exec(source)?.[1];

    const strictHit: Record<string, boolean> = {
      cron: cron !== undefined,
      concurrency: concurrency !== undefined,
      retries: retries !== undefined,
    };
    throwIgnoredMetaFields(name, detectIgnoredMetaFields(source, strictHit));

    const manifest: TaskManifest = { name, filePath: normalizedFile };
    if (cron !== undefined) manifest.cron = cron;
    if (concurrency !== undefined) manifest.concurrency = parseNumericLiteral(concurrency);
    if (retries !== undefined) manifest.retries = parseNumericLiteral(retries);

    tasks.push(manifest);
  }

  // fast-glob 不保证文件顺序——清单顺序无语义，按任务名字母序排序
  // （与路由清单 sortRoutes 的字母序对称），保证 faapi-tasks.js 产物内容确定
  return tasks.sort((a, b) => a.name.localeCompare(b.name));
}
