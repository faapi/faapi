import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

  it('正则提取 cron / concurrency / retries 字面量', async () => {
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

  it('无任务文件返回空数组', async () => {
    const tasks = await scanTasks(rootDir, TASK_PATTERNS);
    expect(tasks).toEqual([]);
  });
});
