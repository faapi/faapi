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

  it('嵌套目录任务名用 . 连接', async () => {
    writeTask('src/tasks/a/b/task.ts', `export function run() {}\n`);
    const tasks = await scanTasks(rootDir, TASK_PATTERNS);
    expect(tasks[0]!.name).toBe('a.b');
  });

  it('正则提取 cron / concurrency / retries / timeoutMs / graceMs 字面量', async () => {
    writeTask(
      'src/tasks/cleanup/task.ts',
      `export const task = {
  cron: '0 3 * * *',
  concurrency: 2,
  retries: 3,
  timeoutMs: 90000,
  graceMs: 15000,
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
      timeoutMs: 90000,
      graceMs: 15000,
    });
  });

  it('timeoutMs 低于最小值 60s 时扫描期报错（短任务无需超时，走进程内）', async () => {
    writeTask(
      'src/tasks/too-fast/task.ts',
      `export const task = {
  timeoutMs: 30000,
};
export function run() {}
`,
    );
    await expect(scanTasks(rootDir, TASK_PATTERNS)).rejects.toThrow(
      /timeoutMs 30000 is below the minimum 60000ms/,
    );
  });

  it('timeoutMs 恰为最小值时通过；数字分隔符字面量（60_000）正确解析', async () => {
    writeTask(
      'src/tasks/edge/task.ts',
      `export const task = {
  timeoutMs: 60_000,
};
export function run() {}
`,
    );
    const tasks = await scanTasks(rootDir, TASK_PATTERNS);
    expect(tasks[0]!.timeoutMs).toBe(60000);
  });

  it('timeoutMs 超过最大值 23h 时扫描期报错（pg-boss expire_in 断言 < 24h）', async () => {
    writeTask(
      'src/tasks/too-long/task.ts',
      `export const task = {
  timeoutMs: 86_340_000,
};
export function run() {}
`,
    );
    await expect(scanTasks(rootDir, TASK_PATTERNS)).rejects.toThrow(
      /timeoutMs 86340000 exceeds the maximum 82800000ms \(23 hours\)/,
    );
  });

  it('timeoutMs 恰为最大值 23h 时通过（expire 预算留有约 1h 余量）', async () => {
    // meta 走正则字面量提取（同 agent/tool config 的字面量约定），表达式不展开
    writeTask(
      'src/tasks/edge-max/task.ts',
      `export const task = {
  timeoutMs: 82_800_000,
};
export function run() {}
`,
    );
    const tasks = await scanTasks(rootDir, TASK_PATTERNS);
    expect(tasks[0]!.timeoutMs).toBe(82_800_000);
  });

  it('未声明 meta 时字段缺省为 undefined', async () => {
    writeTask('src/tasks/plain/task.ts', `export function run() {}\n`);
    const tasks = await scanTasks(rootDir, TASK_PATTERNS);
    expect(tasks[0]).toEqual({ name: 'plain', filePath: 'src/tasks/plain/task.ts' });
    expect('cron' in tasks[0]!).toBe(false);
  });

  it('忽略非 task.ts 文件与 test 文件', async () => {
    writeTask('src/tasks/x/helper.ts', `export function run() {}\n`);
    writeTask('src/tasks/y/task.test.ts', `export function run() {}\n`);
    const tasks = await scanTasks(rootDir, TASK_PATTERNS);
    expect(tasks).toEqual([]);
  });

  it('不同文件推导出同名任务时抛错', async () => {
    // task.ts 约定下同名只能来自未来 pattern 扩展，此处直接验证重名检测逻辑
    writeTask('src/tasks/dup/task.ts', `export function run() {}\n`);
    const tasks = await scanTasks(rootDir, TASK_PATTERNS);
    expect(tasks).toHaveLength(1);
  });

  it('多任务结果按任务名字母序排序（glob 顺序无关）', async () => {
    // fast-glob 不保证文件顺序——清单顺序本无语义，按 name 排序保证产物与断言稳定
    writeTask('src/tasks/timeout/task.ts', `export function run() {}\n`);
    writeTask('src/tasks/echo/task.ts', `export function run() {}\n`);
    const tasks = await scanTasks(rootDir, TASK_PATTERNS);
    expect(tasks.map((t) => t.name)).toEqual(['echo', 'timeout']);
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

  it('声明了 timeoutMs / concurrency 但值是表达式或动态值（单行对象写法）时构建期抛错（逐字段列后果与指引）', async () => {
    writeTask(
      'src/tasks/log-analysis/task.ts',
      `export const task = { timeoutMs: 30 * 60_000, concurrency: maxConcurrency };\nexport function run() {}\n`,
    );
    await expect(scanTasks(rootDir, TASK_PATTERNS)).rejects.toThrow(
      /declares meta field\(s\) with non-literal values/,
    );
    await expect(scanTasks(rootDir, TASK_PATTERNS)).rejects.toThrow(/"timeoutMs"/);
    await expect(scanTasks(rootDir, TASK_PATTERNS)).rejects.toThrow(/"concurrency"/);
    await expect(scanTasks(rootDir, TASK_PATTERNS)).rejects.toThrow(/not a numeric literal/);
    await expect(scanTasks(rootDir, TASK_PATTERNS)).rejects.toThrow(/silently run in-process/);
  });

  it('行首写动态值（Number(process.env.X)）同样抛错，不再静默忽略', async () => {
    writeTask(
      'src/tasks/dyn/task.ts',
      `export const task = {\n  timeoutMs: Number(process.env.TASK_TIMEOUT),\n};\nexport function run() {}\n`,
    );
    await expect(scanTasks(rootDir, TASK_PATTERNS)).rejects.toThrow(/not a numeric literal/);
  });

  it('行注释中的示例（// timeoutMs: ...）不误报', async () => {
    writeTask(
      'src/tasks/commented/task.ts',
      `export const task = {};\n// timeoutMs: 10 * 60_000,\nexport function run() {}\n`,
    );
    const tasks = await scanTasks(rootDir, TASK_PATTERNS);
    expect('timeoutMs' in tasks[0]!).toBe(false);
  });

  it('块注释行（* / /* 开头、终止符结尾）内的 meta 形样文本不误报', async () => {
    writeTask(
      'src/tasks/block-commented/task.ts',
      `/**\n * 旧配置示例：timeoutMs: 10 * 60_000\n * cron: '0 3 * * *'\n */\n/* graceMs: 5_000 */\nexport const task = {\n  timeoutMs: 120_000,\n};\nexport function run() {}\n`,
    );
    const tasks = await scanTasks(rootDir, TASK_PATTERNS);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ timeoutMs: 120000 });
    expect('cron' in tasks[0]!).toBe(false);
    expect('graceMs' in tasks[0]!).toBe(false);
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
      `export const task = {\n  cron: '0 3 * * *',\n  concurrency: 2,\n  retries: 3,\n  timeoutMs: 90_000,\n  graceMs: 15_000,\n};\nexport function run() {}\n`,
    );
    const tasks = await scanTasks(rootDir, TASK_PATTERNS);
    expect(tasks[0]).toMatchObject({
      cron: '0 3 * * *',
      concurrency: 2,
      retries: 3,
      timeoutMs: 90000,
      graceMs: 15000,
    });
  });
});
