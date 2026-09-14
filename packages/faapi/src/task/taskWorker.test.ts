import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runTaskInWorker, TaskCancelledError } from './taskWorker';
import {
  createToolRegistry,
  createAgentRegistry,
  createSkillRegistry,
  createAgentHandleStore,
  createTaskHandleStore,
  createTaskRegistriesView,
} from '../injection/registries';
import { createTaskRegistry } from './taskRegistry';
import type { AgentMetadata } from '../ast/extractAgentMetadata';

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

  it('错误保真：自定义属性含不可克隆值（函数）时丢弃 props、保底 name/message', async () => {
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
    expect(err.message).toBe('db down');
    expect(err.name).toBe('DbError');
    expect((err as Error & { onRetry?: unknown }).onRetry).toBeUndefined();
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
    const skillRegistry = createSkillRegistry();
    const metas: AgentMetadata[] = [
      {
        name: 'log-analyzer',
        description: 'analyzer',
        filePath: 'dist/agents/log-analyzer/handler.js',
        hasRun: false,
        systemPrompt: 'p',
        tools: ['parse', 'missing-tool'],
        agents: ['helper', 'missing-sub'],
        model: 'gpt-4o',
        maxTurns: 5,
      },
      { name: 'helper', filePath: 'dist/agents/helper/handler.js', hasRun: true },
    ];
    agentRegistry.hydrate(metas);
    toolRegistry.hydrate([
      { name: 'parse', functionName: 'parse', filePath: 'dist/tools/parse/handler.ts' },
    ]);
    skillRegistry.hydrate([{ name: 'db-skill', systemPrompt: 's' }]);
    const hostView = createTaskRegistriesView({
      tool: toolRegistry,
      agent: agentRegistry,
      skill: skillRegistry,
      task: createTaskRegistry(),
      agentHandle: createAgentHandleStore(),
      taskHandle: createTaskHandleStore(),
    });
    // 与 taskQueue.snapshotRegistries 同构的快照生成
    const snapshot = {
      agents: hostView.agent
        .listAgents()
        .map((core) => hostView.agent.getAgentEntry(core.name))
        .filter((entry): entry is AgentMetadata => entry !== undefined),
      tools: hostView.tool.list(),
      skills: hostView.skill.list(),
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
          skillGet: r.skill.get('db-skill'),
          skillList: r.skill.list(),
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
      skillGet: hostView.skill.get('db-skill'),
      skillList: hostView.skill.list(),
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

  it('注册表快照传入：taskCtx.registries 在 worker 内可查 agent/tool/skill 元数据', async () => {
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
          skill: r.skill.get('db-skill'),
          skills: r.skill.list().map((s) => s.name),
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
            hasRun: false,
            systemPrompt: 'p',
            tools: ['parse'],
            agents: ['helper'],
            model: 'gpt-4o',
            maxTurns: 5,
          },
          { name: 'helper', filePath: 'dist/agents/helper/handler.js', hasRun: true },
        ],
        tools: [{ name: 'parse', functionName: 'parse', filePath: 'dist/tools/parse/handler.ts' }],
        skills: [{ name: 'db-skill', systemPrompt: 's' }],
      },
      timeoutMs: 5000,
    })) as Record<string, unknown>;

    expect(result.agent).toMatchObject({ name: 'log-analyzer', systemPrompt: 'p' });
    // getAgentEntry 返回完整元数据（含 filePath/hasRun，供 worker 内 import agent 产物跑 run）
    expect(result.entry).toEqual({
      name: 'log-analyzer',
      description: 'analyzer',
      filePath: 'dist/agents/log-analyzer/handler.js',
      hasRun: false,
      systemPrompt: 'p',
      tools: ['parse'],
      agents: ['helper'],
      model: 'gpt-4o',
      maxTurns: 5,
    });
    expect(result.agents).toEqual(['log-analyzer', 'helper']);
    expect(result.tool).toMatchObject({ name: 'parse' });
    expect(result.tools).toEqual(['parse']);
    expect(result.skill).toMatchObject({ name: 'db-skill' });
    expect(result.skills).toEqual(['db-skill']);
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
            hasRun: false,
            tools: ['parse', 'missing-tool'],
            agents: ['helper', 'missing-sub'],
          },
          { name: 'helper', filePath: 'dist/agents/helper/handler.js', hasRun: true },
        ],
        tools: [{ name: 'parse', functionName: 'parse', filePath: 'dist/tools/parse/handler.ts' }],
        skills: [],
      },
      timeoutMs: 5000,
    })) as Record<string, unknown>;

    expect(result.asTool).toEqual({
      kind: 'agent',
      name: 'agent.log-analyzer',
      agentName: 'log-analyzer',
      description: undefined,
      metadata: {
        name: 'log-analyzer',
        filePath: 'dist/agents/log-analyzer/handler.js',
        hasRun: false,
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
          skill: r.skill.get('x'),
          skills: r.skill.list(),
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
      skill: undefined,
      skills: [],
    });
  });
});
