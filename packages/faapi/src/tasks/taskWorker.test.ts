import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runTaskInWorker, TaskCancelledError } from './taskWorker';
import {
  createToolRegistry,
  createAgentRegistry,
  createAgentHandleStore,
  createAgentRunnerStore,
  createTaskHandleStore,
  createTaskRegistriesView,
  createLlmChannelStore,
} from '../injection/registries';
import { createTaskRegistry } from './taskRegistry';
import { createAppEventBus } from '../events/appEventBus';
import { toAgentSnapshotRecord } from './taskTypes';
import type { AgentMetadata } from '../agents/agentTypes';

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
    });
  });

  it('resourcesDir 数据字段不进 worker 内的业务 taskCtx（读取根播种走独立链路）', async () => {
    const modulePath = writeTaskModule(
      'res',
      `export function run(payload, taskCtx) {
        return { hasField: 'resourcesDir' in taskCtx };
      }`,
    );
    const result = await runTaskInWorker({
      taskModulePath: modulePath,
      payload: {},
      taskCtx: { ...baseCtx, resourcesDir: '/project/dist/resources' },
      timeoutMs: 5000,
    });
    // taskCtx.resourcesDir（TaskWorkerOptions 内部字段）仅作 workerData 播种数据源，
    // 不出现在业务 taskCtx 上
    expect(result).toEqual({ hasField: false });
  });

  it('taskCtx.tasks 代理：全方法经 RPC 回宿主（onTasksCall），结果回传 worker', async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const modulePath = writeTaskModule(
      'tasks-proxy',
      `export async function run(payload, taskCtx) {
        const enq = await taskCtx.tasks.enqueue('chunks', { i: 1 }, { dedupId: 'k1' });
        const group = await taskCtx.tasks.getGroup('g1');
        return { id: enq.id, group };
      }`,
    );
    const result = await runTaskInWorker({
      taskModulePath: modulePath,
      payload: {},
      taskCtx: baseCtx,
      timeoutMs: 5000,
      onTasksCall: async (method, args) => {
        calls.push({ method, args });
        if (method === 'enqueue') return { id: 'h-1' };
        if (method === 'getGroup')
          return { id: args[0], total: 2, done: 1, failed: 0, cancelled: 0, settled: 1 };
        throw new Error(`unexpected method ${method}`);
      },
    });
    expect(result).toEqual({
      id: 'h-1',
      group: { id: 'g1', total: 2, done: 1, failed: 0, cancelled: 0, settled: 1 },
    });
    expect(calls.map((c) => c.method)).toEqual(['enqueue', 'getGroup']);
    expect(calls[0]!.args).toEqual(['chunks', { i: 1 }, { dedupId: 'k1' }]);
  });

  it('taskCtx.tasks 代理：宿主 handler 抛错回传为 worker 侧异常（reject）', async () => {
    const modulePath = writeTaskModule(
      'tasks-proxy-err',
      `export async function run(payload, taskCtx) {
        try {
          await taskCtx.tasks.enqueue('nope', {});
          return { threw: false };
        } catch (err) {
          return { threw: true, message: err.message };
        }
      }`,
    );
    const result = await runTaskInWorker({
      taskModulePath: modulePath,
      payload: {},
      taskCtx: baseCtx,
      timeoutMs: 5000,
      onTasksCall: async () => {
        throw new Error('[faapi] Unknown task "nope"');
      },
    });
    expect(result).toEqual({ threw: true, message: '[faapi] Unknown task "nope"' });
  });

  it('读取根播种先于任务模块求值：模块顶层（readResource 顶层调用前提）即已绑定', async () => {
    // ESM 静态 import 提升求值——wrapper 必须在任务模块顶层代码执行前播种读取根，
    // 否则任务模块 top-level await 调用 readResource 会得到"未绑定"。模块级 throw
    // 直接证明顺序：未播种时本用例以 worker error 失败
    const modulePath = writeTaskModule(
      'seed-order',
      `const seeded = globalThis[Symbol.for('faapi.resources.dir')];
       if (!seeded) throw new Error('resources dir not seeded at module evaluation');
       export function run() {
         return { seeded, stillSeeded: globalThis[Symbol.for('faapi.resources.dir')] };
       }`,
    );
    const result = await runTaskInWorker({
      taskModulePath: modulePath,
      payload: {},
      taskCtx: { ...baseCtx, resourcesDir: '/project/dist/resources' },
      timeoutMs: 5000,
    });
    expect(result).toEqual({
      seeded: '/project/dist/resources',
      stillSeeded: '/project/dist/resources',
    });
  });

  it('隔离任务不传 config：taskCtx.config 为 undefined（进程配置不跨线程，数据走 payload）', async () => {
    const modulePath = writeTaskModule(
      'no-config',
      `export function run(_payload, taskCtx) {
        return { hasConfig: taskCtx.config !== undefined };
      }`,
    );
    const result = await runTaskInWorker({
      taskModulePath: modulePath,
      payload: {},
      taskCtx: baseCtx,
      timeoutMs: 5000,
    });
    expect(result).toEqual({ hasConfig: false });
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

  it('错误保真：自定义 Error 子类的 name/stack/自定义属性回传宿主（不再只剩 message）', async () => {
    const modulePath = writeTaskModule(
      'rich-error',
      `export function run() {
        class PaymentDeclinedError extends Error {
          code = 'PAYMENT_DECLINED';
          statusCode = 402;
          constructor(message) {
            super(message);
            this.name = 'PaymentDeclinedError';
          }
        }
        throw new PaymentDeclinedError('card was declined');
      }`,
    );
    const err: Error = await runTaskInWorker({
      taskModulePath: modulePath,
      payload: {},
      taskCtx: baseCtx,
      timeoutMs: 5000,
    }).then(
      () => {
        throw new Error('expected rejection');
      },
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('card was declined');
    expect(err.name).toBe('PaymentDeclinedError');
    expect((err as Error & { code?: string }).code).toBe('PAYMENT_DECLINED');
    expect((err as Error & { statusCode?: number }).statusCode).toBe(402);
    // stack 为 worker 侧原始抛出堆栈（含任务模块路径），非宿主重建点
    expect(err.stack).toContain('rich-error');
  });

  it('错误保真：run 抛非 Error 值按 String(err) 回传为 Error', async () => {
    const modulePath = writeTaskModule(
      'throw-string',
      `export function run() { throw 'plain string failure'; }`,
    );
    const err: Error = await runTaskInWorker({
      taskModulePath: modulePath,
      payload: {},
      taskCtx: baseCtx,
      timeoutMs: 5000,
    }).then(
      () => {
        throw new Error('expected rejection');
      },
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('plain string failure');
  });

  it('错误 props 不可克隆：任务显式失败，错误信息含原 name/message 与修复指引（不静默丢属性）', async () => {
    const modulePath = writeTaskModule(
      'bad-props',
      `export function run() {
        const err = new Error('db down');
        err.name = 'DbError';
        err.onRetry = () => {};
        throw err;
      }`,
    );
    const err: Error = await runTaskInWorker({
      taskModulePath: modulePath,
      payload: {},
      taskCtx: baseCtx,
      timeoutMs: 5000,
    }).then(
      () => {
        throw new Error('expected rejection');
      },
      (e: Error) => e,
    );
    expect(err.message).toContain('props are not cloneable');
    expect(err.message).toContain('DbError');
    expect(err.message).toContain('db down');
    expect(err.message).toContain('plain data');
    // stack 为 worker 侧原始抛出堆栈
    expect(err.stack).toContain('bad-props');
  });

  it('进度上报：taskCtx.progress 的值经 onProgress 按序回传宿主，不影响结果', async () => {
    const modulePath = writeTaskModule(
      'progress',
      `export async function run(_payload, taskCtx) {
         taskCtx.progress({ step: 1, total: 3 });
         taskCtx.progress({ step: 2, total: 3 });
         return { step: 3 };
       }`,
    );
    const progressValues: unknown[] = [];
    const result = await runTaskInWorker({
      taskModulePath: modulePath,
      payload: {},
      taskCtx: baseCtx,
      onProgress: (value) => progressValues.push(value),
      timeoutMs: 5000,
    });
    expect(result).toEqual({ step: 3 });
    expect(progressValues).toEqual([
      { step: 1, total: 3 },
      { step: 2, total: 3 },
    ]);
  });

  it('不调用 progress：onProgress 不触发，行为与无进度任务一致', async () => {
    const modulePath = writeTaskModule('no-progress', `export function run() { return 'ok'; }`);
    const onProgress = vi.fn();
    const result = await runTaskInWorker({
      taskModulePath: modulePath,
      payload: {},
      taskCtx: baseCtx,
      onProgress,
      timeoutMs: 5000,
    });
    expect(result).toBe('ok');
    expect(onProgress).not.toHaveBeenCalled();
  });

  it('过程事件：taskCtx.emit 的值经 onEvent 按序回传宿主，不影响结果', async () => {
    const modulePath = writeTaskModule(
      'events',
      `export async function run(_payload, taskCtx) {
         taskCtx.emit({ kind: 'stage', at: 'start' });
         taskCtx.emit({ kind: 'stage', at: 'end' });
         return 'ok';
       }`,
    );
    const eventValues: unknown[] = [];
    const result = await runTaskInWorker({
      taskModulePath: modulePath,
      payload: {},
      taskCtx: baseCtx,
      onEvent: (value) => eventValues.push(value),
      timeoutMs: 5000,
    });
    expect(result).toBe('ok');
    expect(eventValues).toEqual([
      { kind: 'stage', at: 'start' },
      { kind: 'stage', at: 'end' },
    ]);
  });

  it('不调用 emit：onEvent 不触发，行为与无事件任务一致', async () => {
    const modulePath = writeTaskModule('no-events', `export function run() { return 'ok'; }`);
    const onEvent = vi.fn();
    const result = await runTaskInWorker({
      taskModulePath: modulePath,
      payload: {},
      taskCtx: baseCtx,
      onEvent,
      timeoutMs: 5000,
    });
    expect(result).toBe('ok');
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('emit 值不可克隆：任务显式失败（错误信息含克隆指引），不静默丢事件', async () => {
    const modulePath = writeTaskModule(
      'uncloneable-event',
      `export function run(_payload, taskCtx) {
         taskCtx.emit({ fn: () => 1 });
         return 'unreachable';
       }`,
    );
    await expect(
      runTaskInWorker({
        taskModulePath: modulePath,
        payload: {},
        taskCtx: baseCtx,
        onEvent: () => {},
        timeoutMs: 5000,
      }),
    ).rejects.toThrow(/task event data is not cloneable/);
  });

  it('taskCtx.tasks 代理：listEvents 经 RPC 回宿主；subscribe 显式拒绝（回调不可跨线程）', async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const modulePath = writeTaskModule(
      'tasks-proxy-events',
      `export async function run(payload, taskCtx) {
         const events = await taskCtx.tasks.listEvents('heavy', { jobId: 'j-1' });
         let subscribeError = '';
         try {
           taskCtx.tasks.subscribe('heavy', () => {});
         } catch (err) {
           subscribeError = err.message;
         }
         return { events, subscribeError };
       }`,
    );
    const result = await runTaskInWorker({
      taskModulePath: modulePath,
      payload: {},
      taskCtx: baseCtx,
      timeoutMs: 5000,
      onTasksCall: async (method, args) => {
        calls.push({ method, args });
        if (method === 'listEvents')
          return [{ task: 'heavy', jobId: 'j-1', attempt: 1, seq: 1, at: 1, data: 'x' }];
        throw new Error(`unexpected method ${method}`);
      },
    });
    expect(result).toEqual({
      events: [{ task: 'heavy', jobId: 'j-1', attempt: 1, seq: 1, at: 1, data: 'x' }],
      subscribeError: expect.stringContaining('subscribe is not available'),
    });
    expect(calls.map((c) => c.method)).toEqual(['listEvents']);
  });

  it('externalSignal 派发时已 aborted：快速失败，不创建 worker（任务不执行）', async () => {
    const markerPath = path.join(dir, 'ran.txt');
    const modulePath = writeTaskModule(
      'never-runs',
      `import fs from 'node:fs';
       export function run() {
         fs.writeFileSync('${markerPath.replace(/\\/g, '\\\\')}', 'x');
         return 'ran';
       }`,
    );
    const controller = new AbortController();
    controller.abort();
    const started = Date.now();
    await expect(
      runTaskInWorker({
        taskModulePath: modulePath,
        payload: {},
        taskCtx: baseCtx,
        timeoutMs: 10_000,
        externalSignal: controller.signal,
        graceMs: 3000,
      }),
    ).rejects.toBeInstanceOf(TaskCancelledError);
    // 快速失败（若走旧路径会空等 3s 宽限期）
    expect(Date.now() - started).toBeLessThan(1000);
    expect(fs.existsSync(markerPath)).toBe(false);
  });

  it('视图一致性：worker 重建视图与宿主 createTaskRegistriesView 输出一致（同一份注册表数据）', async () => {
    const toolRegistry = createToolRegistry();
    const agentRegistry = createAgentRegistry(toolRegistry);
    const metas: AgentMetadata[] = [
      {
        name: 'log-analyzer',
        description: 'analyzer',
        filePath: 'dist/agents/log-analyzer/handler.js',
        systemPrompt: 'p',
        tools: ['parse', 'missing-tool'],
        agents: ['helper', 'missing-sub'],
        maxTurns: 5,
      },
      { name: 'helper', filePath: 'dist/agents/helper/handler.js' },
    ];
    agentRegistry.hydrate(metas);
    toolRegistry.hydrate([
      { name: 'parse', functionName: 'parse', filePath: 'dist/tools/parse/handler.ts' },
    ]);
    const hostView = createTaskRegistriesView({
      tool: toolRegistry,
      agent: agentRegistry,
      task: createTaskRegistry(),
      agentHandle: createAgentHandleStore(),
      agentRunner: createAgentRunnerStore(),
      taskHandle: createTaskHandleStore(),
      llm: createLlmChannelStore(),
      appEvents: createAppEventBus(),
    });
    // 与 taskQueue.snapshotRegistries 同构的快照生成（共用投影函数防漂移）
    const snapshot = {
      agents: hostView.agent
        .listAgents()
        .map((core) => hostView.agent.getAgentEntry(core.name))
        .filter((entry): entry is AgentMetadata => entry !== undefined)
        .map((entry) => toAgentSnapshotRecord(entry)),
      tools: hostView.tool.list(),
    };

    const modulePath = writeTaskModule(
      'view-parity',
      `export function run(_payload, taskCtx) {
        const r = taskCtx.registries;
        return {
          getAgent: r.agent.getAgent('log-analyzer'),
          getAgentEntry: r.agent.getAgentEntry('log-analyzer'),
          listAgents: r.agent.listAgents(),
          asTool: r.agent.asTool('log-analyzer'),
          asToolMissing: r.agent.asTool('nope'),
          resolveAgentTools: r.agent.resolveAgentTools('log-analyzer'),
          resolveAgentToolsNoDecl: r.agent.resolveAgentTools('helper'),
          resolveSubAgents: r.agent.resolveSubAgents('log-analyzer'),
          resolveSubAgentsMissing: r.agent.resolveSubAgents('helper'),
          toolGet: r.tool.get('parse'),
          toolList: r.tool.list(),
        };
      }`,
    );
    const workerResult = (await runTaskInWorker({
      taskModulePath: modulePath,
      payload: {},
      taskCtx: baseCtx,
      registries: snapshot,
      timeoutMs: 5000,
    })) as Record<string, unknown>;

    // 宿主侧对同一份注册表数据做同样的方法调用，逐字段对照
    const hostResult: Record<string, unknown> = {
      getAgent: hostView.agent.getAgent('log-analyzer'),
      getAgentEntry: hostView.agent.getAgentEntry('log-analyzer'),
      listAgents: hostView.agent.listAgents(),
      asTool: hostView.agent.asTool('log-analyzer'),
      asToolMissing: hostView.agent.asTool('nope'),
      resolveAgentTools: hostView.agent.resolveAgentTools('log-analyzer'),
      resolveAgentToolsNoDecl: hostView.agent.resolveAgentTools('helper'),
      resolveSubAgents: hostView.agent.resolveSubAgents('log-analyzer'),
      resolveSubAgentsMissing: hostView.agent.resolveSubAgents('helper'),
      toolGet: hostView.tool.get('parse'),
      toolList: hostView.tool.list(),
    };
    expect(workerResult).toEqual(hostResult);
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
        graceMs: 60,
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
        graceMs: 5000,
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
        graceMs: 200,
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
      graceMs: 1000,
    });
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toBeInstanceOf(TaskCancelledError);
    await expect(pending).rejects.toThrow(/cancelled/);
  });

  it('注册表快照传入：taskCtx.registries 在 worker 内可查 agent/tool 元数据', async () => {
    const modulePath = writeTaskModule(
      'registry',
      `export function run(_payload, taskCtx) {
        const r = taskCtx.registries;
        return {
          agent: r.agent.getAgent('log-analyzer'),
          entry: r.agent.getAgentEntry('log-analyzer'),
          agents: r.agent.listAgents().map((a) => a.name),
          tool: r.tool.get('parse'),
          tools: r.tool.list().map((t) => t.name),
          viewHasNoHydrate: r.agent.hydrate === undefined && r.tool.hydrate === undefined,
        };
      }`,
    );
    const result = (await runTaskInWorker({
      taskModulePath: modulePath,
      payload: {},
      taskCtx: baseCtx,
      registries: {
        agents: [
          {
            name: 'log-analyzer',
            description: 'analyzer',
            filePath: 'dist/agents/log-analyzer/handler.js',
            systemPrompt: 'p',
            tools: ['parse'],
            agents: ['helper'],
            maxTurns: 5,
          },
          { name: 'helper', filePath: 'dist/agents/helper/handler.js' },
        ],
        tools: [{ name: 'parse', functionName: 'parse', filePath: 'dist/tools/parse/handler.ts' }],
      },
      timeoutMs: 5000,
    })) as Record<string, unknown>;

    expect(result.agent).toMatchObject({ name: 'log-analyzer', systemPrompt: 'p' });
    // getAgentEntry 返回完整元数据（含 filePath，任务内查询元数据用）
    expect(result.entry).toEqual({
      name: 'log-analyzer',
      description: 'analyzer',
      filePath: 'dist/agents/log-analyzer/handler.js',
      systemPrompt: 'p',
      tools: ['parse'],
      agents: ['helper'],
      maxTurns: 5,
    });
    expect(result.agents).toEqual(['log-analyzer', 'helper']);
    expect(result.tool).toMatchObject({ name: 'parse' });
    expect(result.tools).toEqual(['parse']);
    expect(result.viewHasNoHydrate).toBe(true);
  });

  it('快照视图派生方法与主进程语义一致：asTool 构造描述符、resolve* 未找到静默跳过', async () => {
    const modulePath = writeTaskModule(
      'derive',
      `export function run(_payload, taskCtx) {
        const r = taskCtx.registries;
        return {
          asTool: r.agent.asTool('log-analyzer'),
          asToolMissing: r.agent.asTool('nope'),
          resolvedTools: r.agent.resolveAgentTools('log-analyzer').map((t) => t.name),
          resolvedToolsNoDecl: r.agent.resolveAgentTools('helper'),
          resolvedSubs: r.agent.resolveSubAgents('log-analyzer').map((a) => a.name),
          resolvedSubsMissing: r.agent.resolveSubAgents('helper'),
        };
      }`,
    );
    const result = (await runTaskInWorker({
      taskModulePath: modulePath,
      payload: {},
      taskCtx: baseCtx,
      registries: {
        agents: [
          {
            name: 'log-analyzer',
            filePath: 'dist/agents/log-analyzer/handler.js',
            tools: ['parse', 'missing-tool'],
            agents: ['helper', 'missing-sub'],
          },
          { name: 'helper', filePath: 'dist/agents/helper/handler.js' },
        ],
        tools: [{ name: 'parse', functionName: 'parse', filePath: 'dist/tools/parse/handler.ts' }],
      },
      timeoutMs: 5000,
    })) as Record<string, unknown>;

    expect(result.asTool).toEqual({
      kind: 'agent',
      name: 'agent-log-analyzer',
      agentName: 'log-analyzer',
      description: undefined,
      metadata: {
        name: 'log-analyzer',
        filePath: 'dist/agents/log-analyzer/handler.js',
        tools: ['parse', 'missing-tool'],
        agents: ['helper', 'missing-sub'],
      },
    });
    expect(result.asToolMissing).toBeUndefined();
    // 不存在的 tool 名静默跳过（与 agentRegistry 语义一致）
    expect(result.resolvedTools).toEqual(['parse']);
    expect(result.resolvedToolsNoDecl).toEqual([]);
    // 不存在的 sub-agent 名静默跳过
    expect(result.resolvedSubs).toEqual(['helper']);
    expect(result.resolvedSubsMissing).toEqual([]);
  });

  it('不传 registries：taskCtx.registries 为空视图（查询返回空，不抛错）', async () => {
    const modulePath = writeTaskModule(
      'emptyview',
      `export function run(_payload, taskCtx) {
        const r = taskCtx.registries;
        return {
          agent: r.agent.getAgent('x'),
          agents: r.agent.listAgents(),
          tool: r.tool.get('x'),
          tools: r.tool.list(),
        };
      }`,
    );
    const result = (await runTaskInWorker({
      taskModulePath: modulePath,
      payload: {},
      taskCtx: baseCtx,
      timeoutMs: 5000,
    })) as Record<string, unknown>;
    expect(result).toEqual({
      agent: undefined,
      agents: [],
      tool: undefined,
      tools: [],
    });
  });
});

describe('runTaskInWorker - taskCtx.log 日志桥', () => {
  it('log 配置下发：taskCtx.log 可用，条目回传宿主（scope/fields/level/message/time）', async () => {
    const modulePath = writeTaskModule(
      'log-basic',
      `export async function run(payload, taskCtx) {
        taskCtx.log.info('settling', { orderId: payload.orderId });
        return taskCtx.log ? 'has-log' : 'no-log';
      }`,
    );
    const entries: any[] = [];
    const result = await runTaskInWorker({
      taskModulePath: modulePath,
      payload: { orderId: 'o-1' },
      taskCtx: baseCtx,
      timeoutMs: 5000,
      log: {
        level: 'debug',
        scope: 'task:t',
        fields: { jobId: 'j1', task: 't', attempt: 1 },
      },
      onLog: (e) => entries.push(e),
    });
    expect(result).toBe('has-log');
    expect(entries).toHaveLength(1);
    expect(entries[0].level).toBe('info');
    expect(entries[0].message).toBe('settling');
    expect(entries[0].scope).toBe('task:t');
    expect(entries[0].fields).toEqual({ jobId: 'j1', task: 't', attempt: 1, orderId: 'o-1' });
    expect(entries[0].time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('worker 侧级别预过滤：level info 时 debug 条目不回传', async () => {
    const modulePath = writeTaskModule(
      'log-filter',
      `export async function run(_payload, taskCtx) {
        taskCtx.log.debug('hidden');
        taskCtx.log.warn('shown');
      }`,
    );
    const entries: any[] = [];
    await runTaskInWorker({
      taskModulePath: modulePath,
      payload: {},
      taskCtx: baseCtx,
      timeoutMs: 5000,
      log: { level: 'info', scope: 'task:t', fields: {} },
      onLog: (e) => entries.push(e),
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].level).toBe('warn');
  });

  it('child 合并 scope（task:t:db），调用处 fields 覆盖构造字段', async () => {
    const modulePath = writeTaskModule(
      'log-child',
      `export async function run(_payload, taskCtx) {
        taskCtx.log.child('db').info('miss', { attempt: 99, extra: 1 });
      }`,
    );
    const entries: any[] = [];
    await runTaskInWorker({
      taskModulePath: modulePath,
      payload: {},
      taskCtx: baseCtx,
      timeoutMs: 5000,
      log: { level: 'debug', scope: 'task:t', fields: { jobId: 'j1', task: 't', attempt: 1 } },
      onLog: (e) => entries.push(e),
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].scope).toBe('task:t:db');
    expect(entries[0].fields).toEqual({ jobId: 'j1', task: 't', attempt: 99, extra: 1 });
  });

  it('fields 不可克隆：按执行错误处理（任务失败，错误信息含修复指引），不静默丢字段', async () => {
    const modulePath = writeTaskModule(
      'log-uncloneable',
      `export async function run(_payload, taskCtx) {
        taskCtx.log.info('with fn', { fn: () => 'x' });
        return 'still-ok';
      }`,
    );
    const entries: any[] = [];
    const err: Error = await runTaskInWorker({
      taskModulePath: modulePath,
      payload: {},
      taskCtx: baseCtx,
      timeoutMs: 5000,
      log: { level: 'debug', scope: 'task:t', fields: { jobId: 'j1' } },
      onLog: (e) => entries.push(e),
    }).then(
      () => {
        throw new Error('expected rejection');
      },
      (e: Error) => e,
    );
    // 条目不回传（postMessage 失败即抛错），任务显式失败——与 progress 同语义
    expect(entries).toHaveLength(0);
    expect(err.message).toContain('log fields are not cloneable');
    expect(err.message).toContain('plain data');
  });

  it('未传 log 配置：taskCtx.log 为 undefined，任务不崩溃', async () => {
    const modulePath = writeTaskModule(
      'log-absent',
      `export function run(_payload, taskCtx) {
        return { hasLog: taskCtx.log !== undefined };
      }`,
    );
    const result = await runTaskInWorker({
      taskModulePath: modulePath,
      payload: {},
      taskCtx: baseCtx,
      timeoutMs: 5000,
    });
    expect(result).toEqual({ hasLog: false });
  });

  // ─── taskCtx.llm 轻量补全通道（隔离路径，RPC 纯转发回宿主） ─────────────

  it('onLlmComplete 已注入：complete 经 RPC 回宿主执行，结果与 options 原样到达，返回值回传', async () => {
    const modulePath = writeTaskModule(
      'llm-rpc-roundtrip',
      `export async function run(_payload, taskCtx) {
        return await taskCtx.llm.complete('classify me', { model: 'm', temperature: 0.2 });
      }`,
    );
    const calls: Array<{ input: string; options: Record<string, unknown> | undefined }> = [];
    const result = await runTaskInWorker({
      taskModulePath: modulePath,
      payload: {},
      taskCtx: baseCtx,
      timeoutMs: 5000,
      onLlmComplete: async (input, options) => {
        calls.push({ input, options });
        return '分类结果';
      },
    });
    expect(result).toBe('分类结果');
    // 宿主侧收到的 options = worker 转发的纯数据选项 + 执行器注入的 signal（业务级取消）
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input).toBe('classify me');
    expect(calls[0]!.options).toMatchObject({ model: 'm', temperature: 0.2 });
    expect((calls[0]!.options as { signal?: unknown }).signal).toBeInstanceOf(AbortSignal);
  });

  it('宿主补全拒绝：错误原样回传 reject（name/message 保真），任务失败', async () => {
    const modulePath = writeTaskModule(
      'llm-rpc-error',
      `export async function run(_payload, taskCtx) {
        return await taskCtx.llm.complete('x');
      }`,
    );
    const err: Error = await runTaskInWorker({
      taskModulePath: modulePath,
      payload: {},
      taskCtx: baseCtx,
      timeoutMs: 5000,
      onLlmComplete: async () => {
        const e = new Error('provider down after 3 attempts');
        e.name = 'LLMProviderError';
        throw e;
      },
    }).then(
      () => {
        throw new Error('expected rejection');
      },
      (e: Error) => e,
    );
    expect(err.name).toBe('LLMProviderError');
    expect(err.message).toBe('provider down after 3 attempts');
  });

  it('onLlmComplete 未注入：taskCtx.llm 为 undefined（通道未注册，能力不存在非降级）', async () => {
    const modulePath = writeTaskModule(
      'llm-absent',
      `export function run(_payload, taskCtx) {
        return { hasLlm: taskCtx.llm !== undefined };
      }`,
    );
    const result = await runTaskInWorker({
      taskModulePath: modulePath,
      payload: {},
      taskCtx: baseCtx,
      timeoutMs: 5000,
    });
    expect(result).toEqual({ hasLlm: false });
  });
});

// ─── buildLlmProxy（workerEntry 纯函数，主线程单测） ─────────────

describe('buildLlmProxy', () => {
  /** 构造代理 + 已发送消息收集器 */
  async function makeProxy() {
    const sent: Array<Record<string, unknown>> = [];
    const { buildLlmProxy } = await import('./workerEntry');
    const { proxy, handleMessage } = buildLlmProxy((msg) => sent.push(msg));
    return { proxy, sent, handleMessage };
  }

  it('ok:true 回传：resolve 补全结果', async () => {
    const { proxy, sent, handleMessage } = await makeProxy();
    const p = proxy.complete('hi');
    expect(sent).toEqual([{ type: 'llm-complete', seq: 1, input: 'hi' }]);
    expect(handleMessage({ type: 'llm-result', seq: 1, ok: true, value: '结果' })).toBe(true);
    await expect(p).resolves.toBe('结果');
  });

  it('ok:false 回传：reject 且 name/message 保真', async () => {
    const { proxy, handleMessage } = await makeProxy();
    const p = proxy.complete('hi', { model: 'm' });
    handleMessage({
      type: 'llm-result',
      seq: 1,
      ok: false,
      error: { name: 'LLMProviderError', message: 'down', stack: undefined, props: {} },
    });
    const err: Error = await p.then(
      () => {
        throw new Error('expected rejection');
      },
      (e: Error) => e,
    );
    expect(err.name).toBe('LLMProviderError');
    expect(err.message).toBe('down');
  });

  it('迟到/未知 seq 与非 llm-result 消息：忽略（返回 true/false 语义正确）', async () => {
    const { handleMessage } = await makeProxy();
    expect(handleMessage({ type: 'other' })).toBe(false);
    expect(handleMessage({ type: 'llm-result', seq: 99, ok: true, value: 'late' })).toBe(true);
  });

  it('options.onFailure 钩子：本地显式拒绝（不发 RPC），指引 try/catch 替代', async () => {
    const { proxy, sent } = await makeProxy();
    await expect(proxy.complete('x', { onFailure: () => {} } as never)).rejects.toThrow(
      /onFailure is not available/,
    );
    expect(sent).toHaveLength(0);
  });

  it('options.signal：剥离后转发（不发 RPC 内 signal），abort 时发 llm-abort 消息', async () => {
    const { proxy, sent, handleMessage } = await makeProxy();
    const controller = new AbortController();
    const p = proxy.complete('x', { model: 'm', signal: controller.signal });
    // signal 剥离：转发负载只含其余纯数据选项
    expect(sent[0]).toEqual({ type: 'llm-complete', seq: 1, input: 'x', options: { model: 'm' } });
    controller.abort();
    expect(sent[1]).toEqual({ type: 'llm-abort', seq: 1 });
    // 宿主 abort 后经 llm-result ok:false 回传取消错误
    handleMessage({
      type: 'llm-result',
      seq: 1,
      ok: false,
      error: { name: 'AgentAbortError', message: 'aborted', stack: undefined, props: {} },
    });
    await expect(p).rejects.toThrow('aborted');
  });

  it('options.signal 已 abort：本地拒绝（不发 RPC）', async () => {
    const { proxy, sent } = await makeProxy();
    const controller = new AbortController();
    controller.abort();
    await expect(proxy.complete('x', { signal: controller.signal })).rejects.toThrow(
      /aborted before dispatch/,
    );
    expect(sent).toHaveLength(0);
  });

  it('options.signal 非 AbortSignal：本地拒绝', async () => {
    const { proxy } = await makeProxy();
    await expect(proxy.complete('x', { signal: 'nope' } as never)).rejects.toThrow(
      /signal must be an AbortSignal/,
    );
  });

  it('send 抛错（不可克隆）：按调用错误 reject 克隆指引', async () => {
    const { buildLlmProxy } = await import('./workerEntry');
    const { proxy } = buildLlmProxy(() => {
      throw new Error('could not be cloned');
    });
    const err: Error = await proxy.complete('x').then(
      () => {
        throw new Error('expected rejection');
      },
      (e: Error) => e,
    );
    expect(err.message).toContain('not cloneable across the worker boundary');
    expect(err.message).toContain('plain data');
  });
});

// ─── ctx.config / ctx.resumed 透传（run 消息 taskCtx 扩展） ───────────

describe('runTaskInWorker · config/resumed 透传', () => {
  it('taskCtx.config/resumed 随 run 消息进入 worker 内业务 ctx', async () => {
    const modulePath = writeTaskModule(
      'ctx-passthrough',
      `export function run(_payload, taskCtx) {
        return {
          config: taskCtx.config,
          resumed: taskCtx.resumed ?? null,
        };
      }`,
    );
    const result = await runTaskInWorker({
      taskModulePath: modulePath,
      payload: {},
      taskCtx: {
        ...baseCtx,
        config: { port: 3000, task: { driver: 'pgboss' } },
        resumed: { state: { plan: 'draft' }, activations: 2 },
      },
      timeoutMs: 5000,
    });
    expect(result).toEqual({
      config: { port: 3000, task: { driver: 'pgboss' } },
      resumed: { state: { plan: 'draft' }, activations: 2 },
    });
  });

  it('未传 config/resumed：worker 内两字段为 undefined（直接构造执行器的测试场景）', async () => {
    const modulePath = writeTaskModule(
      'ctx-absent',
      `export function run(_payload, taskCtx) {
        return { hasConfig: 'config' in taskCtx, hasResumed: 'resumed' in taskCtx };
      }`,
    );
    const result = await runTaskInWorker({
      taskModulePath: modulePath,
      payload: {},
      taskCtx: baseCtx,
      timeoutMs: 5000,
    });
    expect(result).toEqual({ hasConfig: false, hasResumed: false });
  });
});

// ─── taskCtx.suspend RPC（worker 内挂起回传宿主持久化） ───────────

describe('runTaskInWorker · ctx.suspend RPC', () => {
  it('onSuspend 成功：worker 内 await 完成，state 回传宿主，run 正常返回', async () => {
    const received: unknown[] = [];
    const modulePath = writeTaskModule(
      'suspend-ok',
      `export async function run(_payload, taskCtx) {
        await taskCtx.suspend({ plan: 'draft' });
        return 'after-suspend';
      }`,
    );
    const result = await runTaskInWorker({
      taskModulePath: modulePath,
      payload: {},
      taskCtx: baseCtx,
      timeoutMs: 5000,
      onSuspend: async (state) => {
        received.push(state);
      },
    });
    expect(result).toBe('after-suspend');
    expect(received).toEqual([{ plan: 'draft' }]);
  });

  it('onSuspend 拒绝（驱动无 taskState 等）：错误原样回传 worker reject', async () => {
    const modulePath = writeTaskModule(
      'suspend-err',
      `export async function run(_payload, taskCtx) {
        try {
          await taskCtx.suspend();
          return { threw: false };
        } catch (err) {
          return { threw: true, message: err.message };
        }
      }`,
    );
    const result = await runTaskInWorker({
      taskModulePath: modulePath,
      payload: {},
      taskCtx: baseCtx,
      timeoutMs: 5000,
      onSuspend: async () => {
        throw new Error(
          '[faapi] Task driver does not support suspend/resume (TaskDriver.taskState is not implemented).',
        );
      },
    });
    expect(result).toEqual({
      threw: true,
      message:
        '[faapi] Task driver does not support suspend/resume (TaskDriver.taskState is not implemented).',
    });
  });

  it('无 onSuspend handler：worker 内 reject（直接构造执行器的测试场景，与 tasks-call 同口径）', async () => {
    const modulePath = writeTaskModule(
      'suspend-no-handler',
      `export async function run(_payload, taskCtx) {
        try {
          await taskCtx.suspend();
          return { threw: false };
        } catch (err) {
          return { threw: true, message: err.message };
        }
      }`,
    );
    const result = await runTaskInWorker({
      taskModulePath: modulePath,
      payload: {},
      taskCtx: baseCtx,
      timeoutMs: 5000,
    });
    expect(result).toEqual({
      threw: true,
      message: expect.stringContaining('taskCtx.suspend is unavailable'),
    });
  });

  it('state 不可克隆：worker 内抛克隆指引错误（与 emit/log 同口径，不发 RPC）', async () => {
    const modulePath = writeTaskModule(
      'suspend-uncloneable',
      `export async function run(_payload, taskCtx) {
        try {
          await taskCtx.suspend({ fn: () => {} });
          return { threw: false };
        } catch (err) {
          return { threw: true, message: err.message };
        }
      }`,
    );
    const onSuspend = vi.fn(async () => {});
    const result = await runTaskInWorker({
      taskModulePath: modulePath,
      payload: {},
      taskCtx: baseCtx,
      timeoutMs: 5000,
      onSuspend,
    });
    expect(onSuspend).not.toHaveBeenCalled();
    expect(result).toEqual({
      threw: true,
      message: expect.stringContaining('taskCtx.suspend state is not cloneable'),
    });
  });

  it('宽限期内到达的 suspend 回传宿主处理（与 tasks-call 同口径），但超时判定即终局', async () => {
    const received: unknown[] = [];
    const modulePath = writeTaskModule(
      'suspend-grace',
      `export async function run(_payload, taskCtx) {
        await new Promise((r) => setTimeout(r, 200));
        await taskCtx.suspend({ late: true });
        return 'done';
      }`,
    );
    const err = await runTaskInWorker({
      taskModulePath: modulePath,
      payload: {},
      taskCtx: baseCtx,
      timeoutMs: 50,
      graceMs: 500,
      onSuspend: async (state) => {
        received.push(state);
      },
    }).then(
      () => {
        throw new Error('expected rejection');
      },
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(TaskCancelledError);
    expect(received).toEqual([{ late: true }]);
  });
});

// ─── buildSuspendChannel（workerEntry 纯函数，主线程单测） ───────────

describe('buildSuspendChannel', () => {
  it('suspend 发送 { type: suspend, seq, state }，suspend-result ok 回 resolve', async () => {
    const { buildSuspendChannel } = await import('./workerEntry');
    const sent: Array<Record<string, unknown>> = [];
    const channel = buildSuspendChannel((msg) => sent.push(msg));
    const p = channel.suspend({ a: 1 });
    expect(sent).toEqual([{ type: 'suspend', seq: 1, state: { a: 1 } }]);
    expect(channel.handleMessage({ type: 'suspend-result', seq: 1, ok: true })).toBe(true);
    await expect(p).resolves.toBeUndefined();
  });

  it('suspend-result ok:false：reject 并保留错误 name/message', async () => {
    const { buildSuspendChannel } = await import('./workerEntry');
    const channel = buildSuspendChannel(() => {});
    const p = channel.suspend();
    channel.handleMessage({
      type: 'suspend-result',
      seq: 1,
      ok: false,
      error: { name: 'RangeError', message: 'nope', stack: undefined, props: {} },
    });
    await expect(p).rejects.toMatchObject({ name: 'RangeError', message: 'nope' });
  });

  it('未知/迟到 seq：handleMessage 消费但不影响挂起调用', async () => {
    const { buildSuspendChannel } = await import('./workerEntry');
    const channel = buildSuspendChannel(() => {});
    expect(channel.handleMessage({ type: 'suspend-result', seq: 99, ok: true })).toBe(true);
    expect(channel.handleMessage({ type: 'other' })).toBe(false);
  });

  it('state 不可克隆：send 抛错时 suspend 同步 reject 克隆指引（不发消息）', async () => {
    const { buildSuspendChannel } = await import('./workerEntry');
    const channel = buildSuspendChannel(() => {
      throw new Error('() => {} could not be cloned.');
    });
    await expect(channel.suspend({ fn: () => {} })).rejects.toThrow(
      /taskCtx\.suspend state is not cloneable/,
    );
  });
});

// ─── buildAgentRunProxy（workerEntry 纯函数，主线程单测） ──────────────

describe('buildAgentRunProxy', () => {
  it('run 发送 { type: agent-run, seq, agentName, input, options }，agent-run-result ok 回 resolve', async () => {
    const { buildAgentRunProxy } = await import('./workerEntry');
    const sent: Array<Record<string, unknown>> = [];
    const proxy = buildAgentRunProxy((msg) => sent.push(msg));
    const p = proxy.run('分析这份日志', { agent: 'log-analyzer', temperature: 0.2 });
    expect(sent).toEqual([
      {
        type: 'agent-run',
        seq: 1,
        agentName: 'log-analyzer',
        input: '分析这份日志',
        options: { agent: 'log-analyzer', temperature: 0.2 },
      },
    ]);
    expect(
      proxy.handleMessage({ type: 'agent-run-result', seq: 1, ok: true, value: { output: '晴' } }),
    ).toBe(true);
    await expect(p).resolves.toEqual({ output: '晴' });
  });

  it('agent-run-result ok:false：reject 并保留错误 name/message（宿主循环错误原样回传）', async () => {
    const { buildAgentRunProxy } = await import('./workerEntry');
    const proxy = buildAgentRunProxy(() => {});
    const p = proxy.run('hi', { agent: 'x' });
    proxy.handleMessage({
      type: 'agent-run-result',
      seq: 1,
      ok: false,
      error: { name: 'RangeError', message: 'boom', stack: undefined, props: {} },
    });
    await expect(p).rejects.toMatchObject({ name: 'RangeError', message: 'boom' });
  });

  it('options.agent 缺失：本地 reject 不发 RPC（agent 名是调用侧决策）', async () => {
    const { buildAgentRunProxy } = await import('./workerEntry');
    const sent: Array<Record<string, unknown>> = [];
    const proxy = buildAgentRunProxy((msg) => sent.push(msg));
    await expect(proxy.run('hi')).rejects.toThrow(/requires options\.agent/);
    await expect(proxy.run('hi', {})).rejects.toThrow(/requires options\.agent/);
    expect(sent).toEqual([]);
  });

  it('options.provider 为 LLMProvider 实例：本地 reject 指引传 LlmConfig 纯数据', async () => {
    const { buildAgentRunProxy } = await import('./workerEntry');
    const sent: Array<Record<string, unknown>> = [];
    const proxy = buildAgentRunProxy((msg) => sent.push(msg));
    const provider = {
      complete: async () => ({}),
      stream: async function* () {},
    };
    await expect(proxy.run('hi', { agent: 'x', provider })).rejects.toThrow(
      /must be an LlmConfig plain object/,
    );
    expect(sent).toEqual([]);
  });

  it('多调用 seq 递增互不串台；未知/迟到 seq 消费但不影响挂起调用', async () => {
    const { buildAgentRunProxy } = await import('./workerEntry');
    const sent: Array<Record<string, unknown>> = [];
    const proxy = buildAgentRunProxy((msg) => sent.push(msg));
    const p1 = proxy.run('a', { agent: 'x' });
    const p2 = proxy.run('b', { agent: 'y' });
    expect(sent.map((m) => m.seq)).toEqual([1, 2]);
    proxy.handleMessage({ type: 'agent-run-result', seq: 2, ok: true, value: 'y-ok' });
    proxy.handleMessage({ type: 'agent-run-result', seq: 1, ok: true, value: 'x-ok' });
    await expect(p2).resolves.toBe('y-ok');
    await expect(p1).resolves.toBe('x-ok');
    expect(proxy.handleMessage({ type: 'agent-run-result', seq: 99, ok: true })).toBe(true);
    expect(proxy.handleMessage({ type: 'other' })).toBe(false);
  });

  it('参数不可克隆：send 抛错时 run reject 克隆指引（不发消息）', async () => {
    const { buildAgentRunProxy } = await import('./workerEntry');
    const proxy = buildAgentRunProxy(() => {
      throw new Error('() => {} could not be cloned.');
    });
    await expect(proxy.run('hi', { agent: 'x', onEvent: () => {} })).rejects.toThrow(
      /arguments are not cloneable across the worker boundary/,
    );
  });
});

// ─── resourceLimits 透传（meta.maxOldGenerationSizeMb → worker_threads） ──

describe('runTaskInWorker · resourceLimits 透传', () => {
  it('声明 maxOldGenerationSizeMb：worker 内 resourceLimits.maxOldGenerationSizeMb 生效', async () => {
    const modulePath = writeTaskModule(
      'mem-limit',
      `import { resourceLimits } from 'node:worker_threads';
       export function run() {
         return { max: resourceLimits ? resourceLimits.maxOldGenerationSizeMb : null };
       }`,
    );
    const result = await runTaskInWorker({
      taskModulePath: modulePath,
      payload: {},
      taskCtx: baseCtx,
      timeoutMs: 5000,
      maxOldGenerationSizeMb: 64,
    });
    expect(result).toEqual({ max: 64 });
  });

  it('未声明：不传 resourceLimits（worker 用 Node 默认堆上限，看不到自定义值）', async () => {
    const modulePath = writeTaskModule(
      'mem-default',
      `import { resourceLimits } from 'node:worker_threads';
       export function run() {
         return { max: resourceLimits ? resourceLimits.maxOldGenerationSizeMb : null };
       }`,
    );
    const result = await runTaskInWorker({
      taskModulePath: modulePath,
      payload: {},
      taskCtx: baseCtx,
      timeoutMs: 5000,
    });
    // Node 24：未传 resourceLimits 时 worker 内是默认对象（如 maxOldGenerationSizeMb
    // 4096）而非 null——断言与声明路径（64）可区分即可，不绑死 Node 版本默认数
    const { max } = result as { max: number | null };
    expect(max).not.toBe(64);
  });
});

describe('runTaskInWorker · 任务取消传播宿主（agent-run / llm-complete）', () => {
  it('两段式取消第一段即 abort 宿主侧 in-flight 的 agent-run 与 llm-complete 控制器（LLM IO 不白烧 tokens）', async () => {
    const modulePath = writeTaskModule(
      'cancel-propagation',
      `export async function run(payload, taskCtx) {
        const agentP = taskCtx.agent.run('hi', { agent: 'x' });
        const llmP = taskCtx.llm.complete('q');
        return Promise.all([agentP, llmP]).then(() => 'done');
      }`,
    );
    const agentSignals: AbortSignal[] = [];
    const llmSignals: AbortSignal[] = [];
    let agentStarted!: () => void;
    let llmStarted!: () => void;
    const bothStarted = Promise.all([
      new Promise<void>((r) => {
        agentStarted = r;
      }),
      new Promise<void>((r) => {
        llmStarted = r;
      }),
    ]);
    const externalController = new AbortController();
    const pending = runTaskInWorker({
      taskModulePath: modulePath,
      payload: {},
      taskCtx: baseCtx,
      timeoutMs: 10_000,
      graceMs: 0,
      externalSignal: externalController.signal,
      onAgentRun: (_request, signal) => {
        agentSignals.push(signal!);
        agentStarted();
        return new Promise(() => {});
      },
      onLlmComplete: (_input, options) => {
        llmSignals.push((options as { signal: AbortSignal }).signal);
        llmStarted();
        return new Promise(() => {});
      },
    });
    await bothStarted;
    externalController.abort();
    // 取消判定即终局：任务失败为 TaskCancelledError
    await expect(pending).rejects.toBeInstanceOf(TaskCancelledError);
    // 宿主侧 agent-run / llm-complete 的取消控制器在第一段即被 abort
    expect(agentSignals[0]).toBeInstanceOf(AbortSignal);
    expect(agentSignals[0]!.aborted).toBe(true);
    expect(llmSignals[0]).toBeInstanceOf(AbortSignal);
    expect(llmSignals[0]!.aborted).toBe(true);
  });
});
