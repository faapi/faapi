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
