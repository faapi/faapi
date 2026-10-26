/**
 * executeTool 校验顺序测试——ctx 声明即校验先于 agent:before-tool-call 事件
 *
 * ctx 装配错误是编程/装配问题（前置条件不满足），不应流进业务订阅端：事件只应
 * 面对合成正确的 ctx 做业务鉴权。顺序：ctx 校验门禁 → before-tool-call 事件 →
 * 白名单 → 执行半段（executeToolCall 的 input 校验 + ctx 二次校验为防御纵深）。
 *
 * 详见 authHooks.md 与 runtime/agentToolContext.md「声明即校验强制点」。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createAgentTestHarness, type AgentTestHarness } from '@faapi/faapi/testing';
import { Agent, type AgentDeps } from './agent';
import { createScriptLLM } from './scriptLlm';
import { createStandaloneToolContext } from './standaloneToolContext';
import { createAppEventBus, type AppEventEmitter } from '@faapi/faapi';

/** 事件收集器：bus（可订阅）+ 发射名序列 + 注入 deps 的 emitAppEvent */
function createCollector() {
  const bus = createAppEventBus();
  const names: string[] = [];
  const emitAppEvent: AppEventEmitter = async (name, payload) => {
    names.push(name);
    return bus.emit(name, payload);
  };
  return { bus, names, emitAppEvent };
}

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: 'ES2022',
    module: 'ESNext',
    moduleResolution: 'Bundler',
    strict: true,
    skipLibCheck: true,
  },
  include: ['src'],
});

function writeProject(root: string): void {
  const w = (rel: string, content: string) => {
    const abs = join(root, rel);
    mkdirSync(abs.slice(0, abs.lastIndexOf('/')), { recursive: true });
    writeFileSync(abs, content);
  };

  w('tsconfig.json', TSCONFIG);

  // tool：第二参声明业务校验类型（ctxTypeName = OrderCtx）
  w(
    'src/tools/order/handler.ts',
    `export interface OrderCtx {
  currentUserId: number;
}

export interface OrderInput {
  orderId: string;
}

export async function getOrder(input: OrderInput, ctx: OrderCtx) {
  return { orderId: input.orderId, userId: ctx.currentUserId };
}
`,
  );

  w(
    'src/agents/runner/handler.ts',
    `export const config = {
  systemPrompt: '测试 agent',
  tools: ['order_getOrder'],
  maxTurns: 3,
};
`,
  );
}

describe('executeTool 校验顺序——ctx 声明即校验先于 before-tool-call 事件', () => {
  let projectRoot: string;
  let h: AgentTestHarness;

  const makeDeps = (ctx: ReturnType<typeof createStandaloneToolContext>): AgentDeps => ({
    providers: new Map(),
    llms: {},
    rootDir: h.rootDir,
    ctx,
    getAgent: h.registries.agent.getAgent,
    getAgentEntry: h.registries.agent.getAgentEntry,
    getTool: h.registries.tool.get,
    resolveAgentTools: h.registries.agent.resolveAgentTools,
    resolveSubAgents: h.registries.agent.resolveSubAgents,
    loadToolModule: (filePath, functionName) => {
      const fp = isAbsolute(filePath) ? filePath : resolve(h.rootDir, filePath);
      // harness 场景走主包 loader（与生产同口径）
      return import('@faapi/faapi').then(({ loadToolModule }) =>
        loadToolModule(fp, functionName, h.rootDir),
      );
    },
    // generated 模式 schema 解析（ctx 校验依赖 resolveToolSchema，缺省则门禁早退）
    ...(h.resolveToolSchema ? { resolveToolSchema: h.resolveToolSchema } : {}),
  });

  beforeAll(async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'faapi-ctx-order-'));
    writeProject(projectRoot);
    h = await createAgentTestHarness({ rootDir: projectRoot, schemaMode: 'generated' });
  });

  afterAll(async () => {
    await h.close();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('ctx 装配错误：先于事件拒绝——before/after-tool-call 均不发射,handler 不被触达', async () => {
    const events = createCollector();
    const deps = {
      ...makeDeps(createStandaloneToolContext()),
      emitAppEvent: events.emitAppEvent,
    };
    const agent = new Agent(deps);
    const llm = createScriptLLM([
      { toolCalls: [{ name: 'order_getOrder', arguments: { orderId: 'o1' } }] },
      { content: 'done' },
    ]);

    await agent.run('查订单', { agent: 'runner', provider: llm });

    // ctx 门禁先于 tool 链事件——before/after 均不发射（root-input 等其他事件照常）
    expect(events.names.filter((n) => n.includes('tool-call'))).toEqual([]);
  });

  it('ctx 完整：事件在 handler 前正常发射（守卫语义不变,顺序 guard → after）', async () => {
    const events = createCollector();
    events.bus.on('agent:before-tool-call', (e) => {
      expect(e.args).toEqual({ orderId: 'o1' });
      expect((e.ctx as unknown as { currentUserId: number }).currentUserId).toBe(42);
    });
    const deps = {
      ...makeDeps(createStandaloneToolContext({ currentUserId: 42 })),
      emitAppEvent: events.emitAppEvent,
    };
    const agent = new Agent(deps);
    const llm = createScriptLLM([
      { toolCalls: [{ name: 'order_getOrder', arguments: { orderId: 'o1' } }] },
      { content: 'done' },
    ]);

    await agent.run('查订单', { agent: 'runner', provider: llm });

    // 同轮其他事件（root-input/filter-tools/system-prompt/input）照常发射,此处只锚定 tool 链顺序
    expect(events.names.filter((n) => n.includes('tool-call'))).toEqual([
      'agent:before-tool-call',
      'agent:before-tool-call:order_getOrder',
      'agent:after-tool-call',
      'agent:after-tool-call:order_getOrder',
    ]);
  });
});
