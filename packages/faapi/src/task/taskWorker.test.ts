import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runTaskInWorker, TaskCancelledError } from './taskWorker';

/**
 * taskWorker 真实 worker 线程集成测试：
 * 任务模块写入临时目录（.mjs 强制 ESM），验证执行、结果回传、两段式取消与真终止
 */

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faapi-task-worker-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeTaskModule(name: string, code: string): string {
  const modulePath = path.join(dir, `${name}.mjs`);
  fs.writeFileSync(modulePath, code, 'utf-8');
  return modulePath;
}

const baseCtx = {
  config: { db: { host: 'h' } },
  job: { id: 'j1', name: 't', attempt: 1 },
};

describe('runTaskInWorker', () => {
  it('正常执行：payload/taskCtx 传入，返回值结构化回传', async () => {
    const modulePath = writeTaskModule(
      'ok',
      `export function run(payload, taskCtx) {
        return {
          echoed: payload.token,
          jobId: taskCtx.job.id,
          jobName: taskCtx.job.name,
          attempt: taskCtx.job.attempt,
          hasSignal: taskCtx.signal instanceof AbortSignal,
          configData: taskCtx.config.db,
        };
      }`,
    );
    const result = await runTaskInWorker({
      taskModulePath: modulePath,
      payload: { token: 'a' },
      taskCtx: baseCtx,
      timeoutMs: 5000,
    });
    expect(result).toEqual({
      echoed: 'a',
      jobId: 'j1',
      jobName: 't',
      attempt: 1,
      hasSignal: true,
      configData: { host: 'h' },
    });
  });

  it('config 含函数字段：降级为 JSON 快照（丢函数、留数据）', async () => {
    const modulePath = writeTaskModule(
      'config',
      `export function run(_payload, taskCtx) {
        return { db: taskCtx.config.db, hasFn: typeof taskCtx.config.onEvent };
      }`,
    );
    const result = await runTaskInWorker({
      taskModulePath: modulePath,
      payload: {},
      taskCtx: {
        config: { db: { host: 'h' }, onEvent: () => 'fn' },
        job: baseCtx.job,
      },
      timeoutMs: 5000,
    });
    expect(result).toEqual({ db: { host: 'h' }, hasFn: 'undefined' });
  });

  it('run 抛错：错误消息回传 reject', async () => {
    const modulePath = writeTaskModule(
      'boom',
      `export function run() { throw new Error('boom inside worker'); }`,
    );
    await expect(
      runTaskInWorker({
        taskModulePath: modulePath,
        payload: {},
        taskCtx: baseCtx,
        timeoutMs: 5000,
      }),
    ).rejects.toThrow('boom inside worker');
  });

  it('模块无 run 导出：报错回传', async () => {
    const modulePath = writeTaskModule('norun', `export const x = 1;`);
    await expect(
      runTaskInWorker({
        taskModulePath: modulePath,
        payload: {},
        taskCtx: baseCtx,
        timeoutMs: 5000,
      }),
    ).rejects.toThrow(/no run export/i);
  });

  it('任务模块不存在：worker error 回传 reject', async () => {
    await expect(
      runTaskInWorker({
        taskModulePath: path.join(dir, 'missing.mjs'),
        payload: {},
        taskCtx: baseCtx,
        timeoutMs: 5000,
      }),
    ).rejects.toThrow();
  });

  it('超时 + 任务不配合：宽限期后 terminate 真终止（不等待任务自然结束）', async () => {
    // 任务 sleep 10s 且不监听 signal——若框架不真终止，宿主要等满 10s
    const modulePath = writeTaskModule(
      'stuck',
      `export function run() {
        return new Promise((resolve) => setTimeout(() => resolve('never'), 10_000));
      }`,
    );
    const started = Date.now();
    await expect(
      runTaskInWorker({
        taskModulePath: modulePath,
        payload: {},
        taskCtx: baseCtx,
        timeoutMs: 100,
        killGraceMs: 60,
      }),
    ).rejects.toBeInstanceOf(TaskCancelledError);
    // 100ms 超时 + 60ms 宽限 ≈ 160ms——远小于任务自然结束的 10s，证明执行被真终止
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('超时 + 任务配合取消：abort 后任务在宽限内自行退出，立即失败返回', async () => {
    const modulePath = writeTaskModule(
      'cooperative',
      `export function run(_payload, taskCtx) {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve('never'), 10_000);
          taskCtx.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(taskCtx.signal.reason);
          });
        });
      }`,
    );
    const started = Date.now();
    await expect(
      runTaskInWorker({
        taskModulePath: modulePath,
        payload: {},
        taskCtx: baseCtx,
        timeoutMs: 100,
        killGraceMs: 5000,
      }),
    ).rejects.toBeInstanceOf(TaskCancelledError);
    // 任务在宽限内退出 → 立即返回，不等满 5s 宽限期
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('宽限内迟到的完成不翻案——超时判定即终局', async () => {
    // 任务收到 abort 后 30ms 再 resolve('late')（宽限 200ms 内到达）——结果必须仍是失败
    const modulePath = writeTaskModule(
      'late',
      `export function run(_payload, taskCtx) {
        return new Promise((resolve) => {
          taskCtx.signal.addEventListener('abort', () => {
            setTimeout(() => resolve('late'), 30);
          });
        });
      }`,
    );
    await expect(
      runTaskInWorker({
        taskModulePath: modulePath,
        payload: {},
        taskCtx: baseCtx,
        timeoutMs: 100,
        killGraceMs: 200,
      }),
    ).rejects.toBeInstanceOf(TaskCancelledError);
  });

  it('externalSignal abort 触发取消（驱动停机路径）', async () => {
    const modulePath = writeTaskModule(
      'external',
      `export function run(_payload, taskCtx) {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve('never'), 10_000);
          taskCtx.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(taskCtx.signal.reason);
          });
        });
      }`,
    );
    const controller = new AbortController();
    const pending = runTaskInWorker({
      taskModulePath: modulePath,
      payload: {},
      taskCtx: baseCtx,
      timeoutMs: 10_000,
      externalSignal: controller.signal,
      killGraceMs: 1000,
    });
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toBeInstanceOf(TaskCancelledError);
    await expect(pending).rejects.toThrow(/cancelled/);
  });
});
