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

  it('嵌套目录任务名用 _ 连接（两种文件同规则，与 agent / tool 目录命名一致）', async () => {
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
      ['a_b', 'inline'],
      ['c_d', 'isolated'],
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
      /task\.ts\) declares timeoutMs\/graceMs\/maxOldGenerationSizeMb — in-process tasks \(task\.ts\) do not take timeout or heap settings/,
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

  it('多行对象写法的表达式值不被前导数字静默截取（数字字段后边界——表达式交字面量守卫显式抛错，而非误提取为错值后走范围校验）', async () => {
    writeTask(
      'src/tasks/expr-line-start/worker.ts',
      `export const task = {\n  timeoutMs: 30 * 60_000,\n  concurrency: 2 * 1,\n  maxOldGenerationSizeMb: 128 * 2,\n};\nexport function run() {}\n`,
    );
    // 修复前：timeoutMs 被静默截取为 30（意图 30 分钟 = 1_800_000），错误面是
    // 「低于最小值」的误导性范围报错；修复后：统一由字面量守卫报 not a numeric literal
    await expect(scanTasks(rootDir, TASK_PATTERNS)).rejects.toThrow(
      /"timeoutMs": value is not a numeric literal/,
    );
    await expect(scanTasks(rootDir, TASK_PATTERNS)).rejects.toThrow(
      /"concurrency": value is not a numeric literal/,
    );
    await expect(scanTasks(rootDir, TASK_PATTERNS)).rejects.toThrow(
      /"maxOldGenerationSizeMb": value is not a numeric literal/,
    );
  });

  it('行尾注释不误伤：值后跟 // / /* 注释（无逗号）时字面量正常提取（后边界 lookahead 放行注释）', async () => {
    writeTask(
      'src/tasks/commented-value/worker.ts',
      `export const task = {\n  timeoutMs: 60_000 // one minute\n  ,\n  graceMs: 5_000 /* grace */,\n};\nexport function run() {}\n`,
    );
    const tasks = await scanTasks(rootDir, TASK_PATTERNS);
    expect(tasks[0]).toMatchObject({ mode: 'isolated', timeoutMs: 60000, graceMs: 5000 });
  });

  it('cron 字符串字段同款后边界：拼接表达式不被引号前缀静默截取（交字面量守卫显式抛错）', async () => {
    writeTask(
      'src/tasks/cron-expr/worker.ts',
      `const suffix = '0 5';\nexport const task = {\n  cron: '0 3 * * *' + suffix,\n  timeoutMs: 60_000,\n};\nexport function run() {}\n`,
    );
    // 修复前：CRON_RE 无后边界，闭合引号即停止——静默提取 '0 3 * * *'（意图拼接
    // 出完整表达式），声明失效但扫描通过；修复后：统一交字面量守卫报错
    await expect(scanTasks(rootDir, TASK_PATTERNS)).rejects.toThrow(
      /"cron": value is not a string literal/,
    );
  });

  it('cron 值行尾注释不误伤：值后跟 // 注释（无逗号）时字符串字面量正常提取', async () => {
    writeTask(
      'src/tasks/cron-comment/worker.ts',
      `export const task = {\n  cron: '0 3 * * *' // nightly\n  ,\n  timeoutMs: 60_000,\n};\nexport function run() {}\n`,
    );
    const tasks = await scanTasks(rootDir, TASK_PATTERNS);
    expect(tasks[0]).toMatchObject({ mode: 'isolated', cron: '0 3 * * *', timeoutMs: 60000 });
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

describe('scanTasks maxOldGenerationSizeMb（worker 堆上限，隔离专用）', () => {
  it('worker.ts 声明数字字面量时提取进清单（下划线分隔同样解析）', async () => {
    writeTask(
      'src/tasks/mem-heavy/worker.ts',
      `export const task = {\n  timeoutMs: 60_000,\n  maxOldGenerationSizeMb: 512,\n};\nexport function run() {}\n`,
    );
    const tasks = await scanTasks(rootDir, TASK_PATTERNS);
    expect(tasks[0]).toMatchObject({
      mode: 'isolated',
      timeoutMs: 60_000,
      maxOldGenerationSizeMb: 512,
    });
  });

  it('未声明时清单缺省该字段（Node 默认堆上限，行为不变）', async () => {
    writeTask(
      'src/tasks/plain/worker.ts',
      `export const task = {\n  timeoutMs: 60_000,\n};\nexport function run() {}\n`,
    );
    const tasks = await scanTasks(rootDir, TASK_PATTERNS);
    expect('maxOldGenerationSizeMb' in tasks[0]!).toBe(false);
  });

  it('task.ts（进程内）声明时构建期报错（迁移指引：worker.ts 专属声明）', async () => {
    writeTask(
      'src/tasks/wrong-file/task.ts',
      `export const task = { maxOldGenerationSizeMb: 256 };\nexport function run() {}\n`,
    );
    await expect(scanTasks(rootDir, TASK_PATTERNS)).rejects.toThrow(
      /task\.ts\) declares timeoutMs\/graceMs\/maxOldGenerationSizeMb/,
    );
  });

  it('task.ts 声明该字段但值为表达式时同样报迁移错（迁移指引优先于字面量守卫）', async () => {
    writeTask(
      'src/tasks/wrong-expr/task.ts',
      `export const task = { maxOldGenerationSizeMb: 128 * 2 };\nexport function run() {}\n`,
    );
    await expect(scanTasks(rootDir, TASK_PATTERNS)).rejects.toThrow(
      /task\.ts\) declares timeoutMs\/graceMs\/maxOldGenerationSizeMb/,
    );
  });

  it('worker.ts 声明但值是表达式时构建期抛错（字面量守卫，不静默忽略）', async () => {
    writeTask(
      'src/tasks/expr-worker/worker.ts',
      `export const task = {\n  timeoutMs: 60_000,\n  maxOldGenerationSizeMb: 128 * 2,\n};\nexport function run() {}\n`,
    );
    await expect(scanTasks(rootDir, TASK_PATTERNS)).rejects.toThrow(/maxOldGenerationSizeMb/);
  });

  it('worker.ts 声明低于下限 16 时扫描期报错（冷启动本身需要十余 MB 堆）', async () => {
    writeTask(
      'src/tasks/too-small/worker.ts',
      `export const task = {\n  timeoutMs: 60_000,\n  maxOldGenerationSizeMb: 8,\n};\nexport function run() {}\n`,
    );
    await expect(scanTasks(rootDir, TASK_PATTERNS)).rejects.toThrow(
      /maxOldGenerationSizeMb 8 is below the minimum 16/,
    );
  });

  it('worker.ts 恰为下限 16 时通过（边界）', async () => {
    writeTask(
      'src/tasks/edge-min/worker.ts',
      `export const task = {\n  timeoutMs: 60_000,\n  maxOldGenerationSizeMb: 16,\n};\nexport function run() {}\n`,
    );
    const tasks = await scanTasks(rootDir, TASK_PATTERNS);
    expect(tasks[0]).toMatchObject({ maxOldGenerationSizeMb: 16 });
  });
});
