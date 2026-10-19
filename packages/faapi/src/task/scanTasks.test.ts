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
  it('识别 src/tasks 下的 task.ts 并推导任务名（mode: inline）', async () => {
    writeTask(
      'src/tasks/send-email/task.ts',
      `export const task = {};
export function run(payload: unknown) {}
`,
    );
    const tasks = await scanTasks(rootDir, TASK_PATTERNS);
    expect(tasks).toEqual([
      { name: 'send-email', filePath: 'src/tasks/send-email/task.ts', mode: 'inline' },
    ]);
  });

  it('worker.ts 声明隔离任务（mode: isolated），任务名推导同规则', async () => {
    writeTask(
      'src/tasks/heavy/worker.ts',
      `export const task = {
  timeoutMs: 60_000,
};
export function run(payload: unknown) {}
`,
    );
    const tasks = await scanTasks(rootDir, TASK_PATTERNS);
    expect(tasks).toEqual([
      {
        name: 'heavy',
        filePath: 'src/tasks/heavy/worker.ts',
        mode: 'isolated',
        timeoutMs: 60000,
      },
    ]);
  });

  it('嵌套目录任务名用 . 连接（两种文件同规则）', async () => {
    writeTask('src/tasks/a/b/task.ts', `export function run() {}\n`);
    writeTask(
      'src/tasks/c/d/worker.ts',
      `export const task = {
  timeoutMs: 60_000,
};
`,
    );
    const tasks = await scanTasks(rootDir, TASK_PATTERNS);
    expect(tasks.map((t) => [t.name, t.mode])).toEqual([
      ['a.b', 'inline'],
      ['c.d', 'isolated'],
    ]);
  });

  it('worker.ts 正则提取 cron / concurrency / retries / timeoutMs / graceMs 字面量', async () => {
    writeTask(
      'src/tasks/cleanup/worker.ts',
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
      mode: 'isolated',
      cron: '0 3 * * *',
      concurrency: 2,
      retries: 3,
      timeoutMs: 90000,
      graceMs: 15000,
    });
  });

  it('task.ts 只提取 cron / concurrency / retries（timeout 字段专属隔离声明）', async () => {
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
      mode: 'inline',
      cron: '0 3 * * *',
      concurrency: 2,
      retries: 3,
    });
    expect('timeoutMs' in tasks[0]!).toBe(false);
    expect('graceMs' in tasks[0]!).toBe(false);
  });

  it('task.ts 声明 timeoutMs 时构建期报错（迁移指引：改名 worker.ts）', async () => {
    writeTask(
      'src/tasks/misguided/task.ts',
      `export const task = {
  timeoutMs: 90000,
};
export function run() {}
`,
    );
    await expect(scanTasks(rootDir, TASK_PATTERNS)).rejects.toThrow(
      /task\.ts\) declares timeoutMs\/graceMs — in-process tasks \(task\.ts\) do not take timeout settings/,
    );
    await expect(scanTasks(rootDir, TASK_PATTERNS)).rejects.toThrow(
      /rename the file to worker\.ts/,
    );
  });

  it('task.ts 声明 graceMs 时同样构建期报错', async () => {
    writeTask(
      'src/tasks/misguided-grace/task.ts',
      `export const task = {
  graceMs: 15000,
};
export function run() {}
`,
    );
    await expect(scanTasks(rootDir, TASK_PATTERNS)).rejects.toThrow(
      /task\.ts\) declares timeoutMs\/graceMs/,
    );
  });

  it('task.ts 声明 timeoutMs 但值是表达式时也报迁移错（迁移指引优先于字面量守卫）', async () => {
    writeTask(
      'src/tasks/misguided-expr/task.ts',
      `export const task = { timeoutMs: 30 * 60_000 };
export function run() {}
`,
    );
    await expect(scanTasks(rootDir, TASK_PATTERNS)).rejects.toThrow(
      /task\.ts\) declares timeoutMs\/graceMs/,
    );
  });

  it('worker.ts 缺 timeoutMs 时构建期报错（隔离必填执行预算）', async () => {
    writeTask(
      'src/tasks/no-budget/worker.ts',
      `export const task = {};
export function run() {}
`,
    );
    await expect(scanTasks(rootDir, TASK_PATTERNS)).rejects.toThrow(
      /worker\.ts\) must declare timeoutMs \(60s–23h\)/,
    );
  });

  it('worker.ts timeoutMs 低于最小值 60s 时扫描期报错（短任务无需隔离，走 task.ts）', async () => {
    writeTask(
      'src/tasks/too-fast/worker.ts',
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

  it('worker.ts timeoutMs 恰为最小值时通过；数字分隔符字面量（60_000）正确解析', async () => {
    writeTask(
      'src/tasks/edge/worker.ts',
      `export const task = {
  timeoutMs: 60_000,
};
export function run() {}
`,
    );
    const tasks = await scanTasks(rootDir, TASK_PATTERNS);
    expect(tasks[0]!.timeoutMs).toBe(60000);
  });

  it('worker.ts timeoutMs 超过最大值 23h 时扫描期报错（pg-boss expire_in 断言 < 24h）', async () => {
    writeTask(
      'src/tasks/too-long/worker.ts',
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

  it('worker.ts timeoutMs 恰为最大值 23h 时通过（expire 预算留有约 1h 余量）', async () => {
    // meta 走正则字面量提取（同 agent/tool config 的字面量约定），表达式不展开
    writeTask(
      'src/tasks/edge-max/worker.ts',
      `export const task = {
  timeoutMs: 82_800_000,
};
export function run() {}
`,
    );
    const tasks = await scanTasks(rootDir, TASK_PATTERNS);
    expect(tasks[0]!.timeoutMs).toBe(82_800_000);
  });

  it('未声明 meta 时字段缺省为 undefined（mode 必有）', async () => {
    writeTask('src/tasks/plain/task.ts', `export function run() {}\n`);
    const tasks = await scanTasks(rootDir, TASK_PATTERNS);
    expect(tasks[0]).toEqual({
      name: 'plain',
      filePath: 'src/tasks/plain/task.ts',
      mode: 'inline',
    });
    expect('cron' in tasks[0]!).toBe(false);
  });

  it('忽略非任务文件与 test 文件（task.ts / worker.ts 之外的命名不识别）', async () => {
    writeTask('src/tasks/x/helper.ts', `export function run() {}\n`);
    writeTask('src/tasks/y/task.test.ts', `export function run() {}\n`);
    writeTask('src/tasks/z/worker.test.ts', `export const task = { timeoutMs: 60_000 };\n`);
    const tasks = await scanTasks(rootDir, TASK_PATTERNS);
    expect(tasks).toEqual([]);
  });

  it('同目录 task.ts 与 worker.ts 并存时抛错（同任务名两种声明，显式失败）', async () => {
    writeTask('src/tasks/dup/task.ts', `export function run() {}\n`);
    writeTask(
      'src/tasks/dup/worker.ts',
      `export const task = { timeoutMs: 60_000 };\nexport function run() {}\n`,
    );
    await expect(scanTasks(rootDir, TASK_PATTERNS)).rejects.toThrow(
      /Task conflict: "dup" declared in both src\/tasks\/dup\/task\.ts and src\/tasks\/dup\/worker\.ts/,
    );
  });

  it('目录名含 . 与嵌套目录推导同名任务时冲突同样抛错（重名检测对两种文件生效）', async () => {
    writeTask('src/tasks/dup.a/task.ts', `export function run() {}\n`);
    writeTask('src/tasks/dup/a/worker.ts', `export const task = {\n  timeoutMs: 60_000,\n};\n`);
    await expect(scanTasks(rootDir, TASK_PATTERNS)).rejects.toThrow(/Task conflict: "dup\.a"/);
  });

  it('多任务结果按任务名字母序排序（glob 顺序无关）', async () => {
    // fast-glob 不保证文件顺序——清单顺序本无语义，按 name 排序保证产物与断言稳定
    writeTask('src/tasks/timeout/worker.ts', `export const task = {\n  timeoutMs: 60_000,\n};\n`);
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

  it('隔离任务声明了 timeoutMs / concurrency 但值是表达式或动态值（单行对象写法）时构建期抛错（逐字段列后果与指引）', async () => {
    writeTask(
      'src/tasks/log-analysis/worker.ts',
      `export const task = { timeoutMs: 30 * 60_000, concurrency: maxConcurrency };\nexport function run() {}\n`,
    );
    await expect(scanTasks(rootDir, TASK_PATTERNS)).rejects.toThrow(
      /declares meta field\(s\) with non-literal values/,
    );
    await expect(scanTasks(rootDir, TASK_PATTERNS)).rejects.toThrow(/"timeoutMs"/);
    await expect(scanTasks(rootDir, TASK_PATTERNS)).rejects.toThrow(/"concurrency"/);
    await expect(scanTasks(rootDir, TASK_PATTERNS)).rejects.toThrow(/not a numeric literal/);
    await expect(scanTasks(rootDir, TASK_PATTERNS)).rejects.toThrow(/without its execution budget/);
  });

  it('隔离任务行首写动态值（Number(process.env.X)）同样抛错，不再静默忽略', async () => {
    writeTask(
      'src/tasks/dyn/worker.ts',
      `export const task = {\n  timeoutMs: Number(process.env.TASK_TIMEOUT),\n};\nexport function run() {}\n`,
    );
    await expect(scanTasks(rootDir, TASK_PATTERNS)).rejects.toThrow(/not a numeric literal/);
  });

  it('行注释中的示例（// timeoutMs: ...）不误报也不触发迁移报错', async () => {
    writeTask(
      'src/tasks/commented/task.ts',
      `export const task = {};\n// timeoutMs: 10 * 60_000,\nexport function run() {}\n`,
    );
    const tasks = await scanTasks(rootDir, TASK_PATTERNS);
    expect('timeoutMs' in tasks[0]!).toBe(false);
  });

  it('块注释行（* / /* 开头、终止符结尾）内的 meta 形样文本不误报', async () => {
    writeTask(
      'src/tasks/block-commented/worker.ts',
      `/**\n * 旧配置示例：timeoutMs: 10 * 60_000\n * cron: '0 3 * * *'\n */\n/* graceMs: 5_000 */\nexport const task = {\n  timeoutMs: 120_000,\n};\nexport function run() {}\n`,
    );
    const tasks = await scanTasks(rootDir, TASK_PATTERNS);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ mode: 'isolated', timeoutMs: 120000 });
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

  it('隔离任务全部字段均为字面量时正常通过（回归）', async () => {
    writeTask(
      'src/tasks/literal/worker.ts',
      `export const task = {\n  cron: '0 3 * * *',\n  concurrency: 2,\n  retries: 3,\n  timeoutMs: 90_000,\n  graceMs: 15_000,\n};\nexport function run() {}\n`,
    );
    const tasks = await scanTasks(rootDir, TASK_PATTERNS);
    expect(tasks[0]).toMatchObject({
      mode: 'isolated',
      cron: '0 3 * * *',
      concurrency: 2,
      retries: 3,
      timeoutMs: 90000,
      graceMs: 15000,
    });
  });

  it('进程内任务全部字段均为字面量时正常通过（回归）', async () => {
    writeTask(
      'src/tasks/literal-inline/task.ts',
      `export const task = {\n  cron: '0 3 * * *',\n  concurrency: 2,\n  retries: 3,\n};\nexport function run() {}\n`,
    );
    const tasks = await scanTasks(rootDir, TASK_PATTERNS);
    expect(tasks[0]).toMatchObject({
      mode: 'inline',
      cron: '0 3 * * *',
      concurrency: 2,
      retries: 3,
    });
  });
});
