import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { scanTasks, TASK_PATTERNS } from './scanTasks';

let rootDir: string;

function writeTask(rel: string, source: string): void {
  const abs = path.resolve(rootDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, source);
}

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'faapi-scan-tasks-'));
});

afterEach(() => {
  fs.rmSync(rootDir, { recursive: true, force: true });
});

describe('scanTasks', () => {
  it('识别 src/tasks 下的 task.ts 并推导任务名', async () => {
    writeTask(
      'src/tasks/send-email/task.ts',
      `export const task = {};
export function run(payload: unknown) {}
`,
    );
    const tasks = await scanTasks(rootDir, TASK_PATTERNS);
    expect(tasks).toEqual([{ name: 'send-email', filePath: 'src/tasks/send-email/task.ts' }]);
  });

  it('worker.ts 声明被扫描静默忽略（历史隔离形态，维护者决策 7.19.0）', async () => {
    writeTask(
      'src/tasks/heavy/worker.ts',
      `export const task = {
  timeoutMs: 60_000,
};
export function run(payload: unknown) {}
`,
    );
    const tasks = await scanTasks(rootDir, TASK_PATTERNS);
    expect(tasks).toEqual([]);
  });

  it('嵌套目录任务名用 _ 连接（与 agent / tool 目录命名一致）', async () => {
    writeTask('src/tasks/a/b/task.ts', `export function run() {}\n`);
    writeTask('src/tasks/c/d/task.ts', `export function run() {}\n`);
    const tasks = await scanTasks(rootDir, TASK_PATTERNS);
    expect(tasks.map((t) => t.name)).toEqual(['a_b', 'c_d']);
  });

  it('task.ts 提取 cron / concurrency / retries 字面量', async () => {
    writeTask(
      'src/tasks/cleanup/task.ts',
      `export const task = {
  cron: '0 3 * * *',
  concurrency: 2,
  retries: 3,
};
export function run() {}
`,
    );
    const tasks = await scanTasks(rootDir, TASK_PATTERNS);
    expect(tasks[0]).toMatchObject({
      name: 'cleanup',
      cron: '0 3 * * *',
      concurrency: 2,
      retries: 3,
    });
  });

  it('未声明 meta 时字段缺省为 undefined', async () => {
    writeTask('src/tasks/plain/task.ts', `export function run() {}\n`);
    const tasks = await scanTasks(rootDir, TASK_PATTERNS);
    expect(tasks[0]).toEqual({ name: 'plain', filePath: 'src/tasks/plain/task.ts' });
    expect('cron' in tasks[0]!).toBe(false);
  });

  it('忽略非任务文件（task.ts 之外的命名不识别，含 test 文件与历史 worker.ts）', async () => {
    writeTask('src/tasks/x/helper.ts', `export function run() {}\n`);
    writeTask('src/tasks/y/task.test.ts', `export function run() {}\n`);
    writeTask('src/tasks/z/worker.test.ts', `export function run() {}\n`);
    const tasks = await scanTasks(rootDir, TASK_PATTERNS);
    expect(tasks).toEqual([]);
  });

  it('目录段含 . 时构建期报错（白名单拒绝，含路径与改名指引）', async () => {
    writeTask('src/tasks/dup.a/task.ts', `export function run() {}\n`);
    await expect(scanTasks(rootDir, TASK_PATTERNS)).rejects.toThrow(
      /Invalid task directory segment "dup\.a" in "src\/tasks\/dup\.a\/task\.ts"/,
    );
    await expect(scanTasks(rootDir, TASK_PATTERNS)).rejects.toThrow(
      /task directory names allow a-z A-Z 0-9 '-' only/,
    );
    await expect(scanTasks(rootDir, TASK_PATTERNS)).rejects.toThrow(/rename the directory/);
  });

  it('目录段含 _ 时构建期报错（_ 保留为嵌套分隔符——与 agent / tool 目录段同规则）', async () => {
    writeTask('src/tasks/dup_a/task.ts', `export function run() {}\n`);
    await expect(scanTasks(rootDir, TASK_PATTERNS)).rejects.toThrow(
      /Invalid task directory segment "dup_a"/,
    );
    await expect(scanTasks(rootDir, TASK_PATTERNS)).rejects.toThrow(
      /'_' is reserved as the nesting separator/,
    );
  });

  it('嵌套目录段逐段校验（深层非法段同样报错）', async () => {
    writeTask('src/tasks/a/b.c/task.ts', `export function run() {}\n`);
    await expect(scanTasks(rootDir, TASK_PATTERNS)).rejects.toThrow(
      /Invalid task directory segment "b\.c" in "src\/tasks\/a\/b\.c\/task\.ts"/,
    );
  });

  it('多任务结果按任务名字母序排序（glob 顺序无关）', async () => {
    // fast-glob 不保证文件顺序——清单顺序本无语义，按 name 排序保证产物与断言稳定
    writeTask('src/tasks/xyz/task.ts', `export function run() {}\n`);
    writeTask('src/tasks/echo/task.ts', `export function run() {}\n`);
    const tasks = await scanTasks(rootDir, TASK_PATTERNS);
    expect(tasks.map((t) => t.name)).toEqual(['echo', 'xyz']);
  });

  it('无任务文件返回空数组', async () => {
    const tasks = await scanTasks(rootDir, TASK_PATTERNS);
    expect(tasks).toEqual([]);
  });
});

describe('scanTasks meta 字面量守卫', () => {
  let errorSpy: MockInstance;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('task.ts 声明了 concurrency 但值是表达式或动态值（单行对象写法）时构建期抛错（逐字段列后果与指引）', async () => {
    writeTask(
      'src/tasks/log-analysis/task.ts',
      `export const task = { retries: 3, concurrency: maxConcurrency };\nexport function run() {}\n`,
    );
    await expect(scanTasks(rootDir, TASK_PATTERNS)).rejects.toThrow(
      /declares meta field\(s\) with non-literal values/,
    );
    await expect(scanTasks(rootDir, TASK_PATTERNS)).rejects.toThrow(/"concurrency"/);
    await expect(scanTasks(rootDir, TASK_PATTERNS)).rejects.toThrow(/not a numeric literal/);
  });

  it('task.ts 行首写动态值（Number(process.env.X)）同样抛错，不再静默忽略', async () => {
    writeTask(
      'src/tasks/dyn/task.ts',
      `export const task = {\n  concurrency: Number(process.env.MAX_CONCURRENCY),\n};\nexport function run() {}\n`,
    );
    await expect(scanTasks(rootDir, TASK_PATTERNS)).rejects.toThrow(/not a numeric literal/);
  });

  it('多行对象写法的表达式值不被前导数字静默截取（数字字段后边界——表达式交字面量守卫显式抛错，而非误提取为错值）', async () => {
    writeTask(
      'src/tasks/expr-line-start/task.ts',
      `export const task = {\n  retries: 2 * 1,\n  concurrency: 2 * 1,\n};\nexport function run() {}\n`,
    );
    // 修复前：retries 被静默截取为 2（意图 2 * 1 表达式），错误面是静默错值；
    // 修复后：统一由字面量守卫报 not a numeric literal
    await expect(scanTasks(rootDir, TASK_PATTERNS)).rejects.toThrow(
      /"retries": value is not a numeric literal/,
    );
    await expect(scanTasks(rootDir, TASK_PATTERNS)).rejects.toThrow(
      /"concurrency": value is not a numeric literal/,
    );
  });

  it('行尾注释不误伤：值后跟 // / /* 注释（无逗号）时字面量正常提取（后边界 lookahead 放行注释）', async () => {
    writeTask(
      'src/tasks/commented-value/task.ts',
      `export const task = {\n  retries: 2 // twice\n  ,\n  concurrency: 3 /* three */,\n};\nexport function run() {}\n`,
    );
    const tasks = await scanTasks(rootDir, TASK_PATTERNS);
    expect(tasks[0]).toMatchObject({ retries: 2, concurrency: 3 });
  });

  it('cron 字符串字段同款后边界：拼接表达式不被引号前缀静默截取（交字面量守卫显式抛错）', async () => {
    writeTask(
      'src/tasks/cron-expr/task.ts',
      `const suffix = '0 5';\nexport const task = {\n  cron: '0 3 * * *' + suffix,\n  retries: 3,\n};\nexport function run() {}\n`,
    );
    // 修复前：CRON_RE 无后边界，闭合引号即停止——静默提取 '0 3 * * *'（意图拼接
    // 出完整表达式），声明失效但扫描通过；修复后：统一交字面量守卫报错
    await expect(scanTasks(rootDir, TASK_PATTERNS)).rejects.toThrow(
      /"cron": value is not a string literal/,
    );
  });

  it('cron 值行尾注释不误伤：值后跟 // 注释（无逗号）时字符串字面量正常提取', async () => {
    writeTask(
      'src/tasks/cron-comment/task.ts',
      `export const task = {\n  cron: '0 3 * * *' // nightly\n  ,\n  retries: 3,\n};\nexport function run() {}\n`,
    );
    const tasks = await scanTasks(rootDir, TASK_PATTERNS);
    expect(tasks[0]).toMatchObject({ cron: '0 3 * * *', retries: 3 });
  });

  it('行注释中的示例（// retries: ...）不误报', async () => {
    writeTask(
      'src/tasks/commented/task.ts',
      `export const task = {};\n// retries: 2 + 1,\nexport function run() {}\n`,
    );
    const tasks = await scanTasks(rootDir, TASK_PATTERNS);
    expect('retries' in tasks[0]!).toBe(false);
  });

  it('块注释行（* / /* 开头、终止符结尾）内的 meta 形样文本不误报', async () => {
    writeTask(
      'src/tasks/block-commented/task.ts',
      `/**\n * 旧配置示例：retries: 2 + 1\n * cron: '0 3 * * *'\n */\n/* concurrency: 4 */\nexport const task = {\n  retries: 3,\n};\nexport function run() {}\n`,
    );
    const tasks = await scanTasks(rootDir, TASK_PATTERNS);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ retries: 3 });
    expect('cron' in tasks[0]!).toBe(false);
    expect('concurrency' in tasks[0]!).toBe(false);
  });

  it('cron 值不是字符串字面量时抛错（文案含修复指引与注释提示）', async () => {
    writeTask(
      'src/tasks/dyn-cron/task.ts',
      `const CRON = '0 3 * * *';\nexport const task = { cron: CRON };\nexport function run() {}\n`,
    );
    await expect(scanTasks(rootDir, TASK_PATTERNS)).rejects.toThrow(/not a string literal/);
    await expect(scanTasks(rootDir, TASK_PATTERNS)).rejects.toThrow(/quoted literal/);
    await expect(scanTasks(rootDir, TASK_PATTERNS)).rejects.toThrow(/block comment/);
  });

  it('全部字段均为字面量时正常通过（回归）', async () => {
    writeTask(
      'src/tasks/literal/task.ts',
      `export const task = {\n  cron: '0 3 * * *',\n  concurrency: 2,\n  retries: 3,\n};\nexport function run() {}\n`,
    );
    const tasks = await scanTasks(rootDir, TASK_PATTERNS);
    expect(tasks[0]).toMatchObject({
      cron: '0 3 * * *',
      concurrency: 2,
      retries: 3,
    });
  });
});
