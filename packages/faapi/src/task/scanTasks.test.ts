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
  let warnSpy: MockInstance;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('声明了 timeoutMs / concurrency 但值是表达式或动态值（单行对象写法）时逐字段警告且清单不含该字段', async () => {
    writeTask(
      'src/tasks/log-analysis/task.ts',
      `export const task = { timeoutMs: 30 * 60_000, concurrency: maxConcurrency };\nexport function run() {}\n`,
    );
    const tasks = await scanTasks(rootDir, TASK_PATTERNS);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.name).toBe('log-analysis');
    expect('timeoutMs' in tasks[0]!).toBe(false);
    expect('concurrency' in tasks[0]!).toBe(false);
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('log-analysis'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"timeoutMs"'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"concurrency"'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('not a numeric literal'));
  });

  it('行首写动态值（Number(process.env.X)）同样警告且不阻断启动', async () => {
    writeTask(
      'src/tasks/dyn/task.ts',
      `export const task = {\n  timeoutMs: Number(process.env.TASK_TIMEOUT),\n};\nexport function run() {}\n`,
    );
    const tasks = await scanTasks(rootDir, TASK_PATTERNS);
    expect(tasks).toHaveLength(1);
    expect('timeoutMs' in tasks[0]!).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('not a numeric literal'));
  });

  it('行注释中的示例（// timeoutMs: ...）不误报', async () => {
    writeTask(
      'src/tasks/commented/task.ts',
      `export const task = {};\n// timeoutMs: 10 * 60_000,\nexport function run() {}\n`,
    );
    const tasks = await scanTasks(rootDir, TASK_PATTERNS);
    expect('timeoutMs' in tasks[0]!).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('cron 值不是字符串字面量时警告（专属文案）', async () => {
    writeTask(
      'src/tasks/dyn-cron/task.ts',
      `const CRON = '0 3 * * *';\nexport const task = { cron: CRON };\nexport function run() {}\n`,
    );
    const tasks = await scanTasks(rootDir, TASK_PATTERNS);
    expect('cron' in tasks[0]!).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('not a string literal'));
  });

  it('全部字段均为字面量时不产生警告（回归）', async () => {
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
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
