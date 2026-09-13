import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import fg from 'fast-glob';
import { createAppBase } from '../cli/createAppCore';
import { scanRoutes } from '../router/scanRoutes';
import { sortRoutes } from '../router/sortRoutes';
import { generateSchemaFiles } from '../cli/generateSchemaFiles';
import { serializeRoutes, writeRoutesModule } from '../cli/generateRoutes';
import { compileSourceFiles } from '../cli/compileSourceFiles';
import { scanTasks, TASK_PATTERNS } from './scanTasks';
import { generateTaskArtifacts } from '../cli/generateTaskArtifacts';

const FIXTURES_DIR = path.resolve(__dirname, '../../fixtures/tasks-basic');

/**
 * 测试用最小队列驱动（TaskDriver 实例经 config 注入直通 loadTaskDriver）：
 * FIFO 顺序执行，无并发上限；验证语义层与驱动的协作，存储/重试语义由子包测试覆盖
 */
const DRIVER_MODULE = `
let seq = 0;
const jobs = [];
const workers = new Map();
let stopped = false;
let running = 0;
function pump() {
  while (!stopped && running < 4 && jobs.length > 0) {
    const job = jobs.shift();
    const worker = workers.get(job.name);
    if (!worker) continue;
    running += 1;
    job.attempt += 1;
    const signal = new AbortController().signal;
    Promise.resolve()
      .then(() => worker.process({ id: job.id, name: job.name, payload: job.payload, attempt: job.attempt, signal }))
      .catch(() => {})
      .finally(() => {
        running -= 1;
        pump();
      });
  }
}
export const driver = {
  async enqueue(name, payload) {
    if (stopped) throw new Error('queue is stopped');
    seq += 1;
    const id = 'e2e-' + seq;
    jobs.push({ id, name, payload, attempt: 0 });
    pump();
    return id;
  },
  async startWorker(name, opts) {
    workers.set(name, opts);
    pump();
  },
  async stop() {
    stopped = true;
    while (running > 0) await new Promise((r) => setTimeout(r, 10));
  },
  async stopWorkers() {
    workers.clear();
  },
};
`;

/** 写 config 产物：task.driver 注入测试驱动实例（loadTaskDriver 对象直通路径） */
function writeConfigWithDriver(dist: string): void {
  fs.writeFileSync(path.join(dist, 'faapi-task-driver.js'), DRIVER_MODULE, 'utf-8');
  fs.writeFileSync(
    path.join(dist, 'faapi-config.js'),
    `import { driver } from './faapi-task-driver.js';\nexport default { task: { driver } };\n`,
    'utf-8',
  );
}

let dist: string;
let echoTarget: string;

beforeEach(() => {
  dist = fs.mkdtempSync(path.join(os.tmpdir(), 'faapi-task-runtime-'));
  echoTarget = path.join(dist, 'echo-result.txt');
  process.env.FAAPI_TASK_ECHO_TARGET = echoTarget;
});

afterEach(() => {
  delete process.env.FAAPI_TASK_ECHO_TARGET;
  fs.rmSync(dist, { recursive: true, force: true });
});

/**
 * 任务子系统端到端：scanTasks → 编译任务源码 → 生成 faapi-tasks.js + zod.js →
 * createAppBase 水合 + 队列启动 → app.tasks / `tasks` 参数注入投递 →
 * worker 消费执行 → app.close() 停机
 */
describe('task runtime e2e', () => {
  it('app.tasks.enqueue 走完整产物链路执行任务', async () => {
    // 产物准备（build 阶段职责的等效操作）
    const tasks = await scanTasks(FIXTURES_DIR, TASK_PATTERNS);
    expect(tasks.map((t) => t.name)).toEqual(['echo']);
    await compileSourceFiles({
      rootDir: FIXTURES_DIR,
      dist,
      files: tasks.map((t) => path.resolve(FIXTURES_DIR, t.filePath)),
    });
    await generateTaskArtifacts(tasks, FIXTURES_DIR, dist);
    const { routes, wsRoutes } = await scanRoutes(FIXTURES_DIR, ['src/api/**/*.ts']);
    const routesPath = path.resolve(dist, 'faapi-routes.js');
    await writeRoutesModule(serializeRoutes(routes, wsRoutes, FIXTURES_DIR, dist), routesPath);
    writeConfigWithDriver(dist);

    // app 启动（队列随 createAppBase 启动）
    const { app } = await createAppBase({ rootDir: FIXTURES_DIR, dist });
    expect(app.tasks).toBeDefined();

    // 入队 → worker 消费 → run 执行（写 marker 文件）
    const { id } = await app.tasks.enqueue('echo', { token: 'hello-task' });
    expect(id).toBeTruthy();
    await viWaitFor(() => fs.existsSync(echoTarget));
    expect(fs.readFileSync(echoTarget, 'utf8')).toBe('hello-task');

    // 任务记录：done + result
    const job = app.tasks.list('echo')[0]!;
    expect(job.status).toBe('done');
    expect(job.result).toEqual({ echoed: 'hello-task' });

    // payload 校验：缺 token 字段 → ValidationError，不入队
    await expect(app.tasks.enqueue('echo', {})).rejects.toThrow();

    await app.close();
  });

  it('handler 的 tasks 参数注入走同一队列', async () => {
    const tasks = await scanTasks(FIXTURES_DIR, TASK_PATTERNS);
    const apiFiles = await fg('src/api/**/*.ts', { cwd: FIXTURES_DIR, absolute: true });
    await compileSourceFiles({
      rootDir: FIXTURES_DIR,
      dist,
      files: [...tasks.map((t) => path.resolve(FIXTURES_DIR, t.filePath)), ...apiFiles],
    });
    await generateTaskArtifacts(tasks, FIXTURES_DIR, dist);
    const { routes, wsRoutes } = await scanRoutes(FIXTURES_DIR, ['src/api/**/*.ts']);
    const sorted = sortRoutes(routes);
    await generateSchemaFiles(sorted, FIXTURES_DIR, dist);
    const routesPath = path.resolve(dist, 'faapi-routes.js');
    await writeRoutesModule(serializeRoutes(routes, wsRoutes, FIXTURES_DIR, dist), routesPath);
    writeConfigWithDriver(dist);

    const { app } = await createAppBase({ rootDir: FIXTURES_DIR, dist });
    // handler 参数注入 tasks（不 listen，走 app.inject 完整请求链路）
    const res = await app.inject({
      method: 'POST',
      path: '/api/task-inject',
      body: { token: 'via-inject' },
    });
    expect(res.status).toBe(200);
    await viWaitFor(() => fs.existsSync(echoTarget));
    expect(fs.readFileSync(echoTarget, 'utf8')).toBe('via-inject');
    await app.close();
  });
});

function viWaitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (cond()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error('viWaitFor timeout'));
        return;
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}
