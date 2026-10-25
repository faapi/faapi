/**
 * executeTool 校验顺序测试——ctx 声明即校验先于 beforeToolCall 守卫
 *
 * ctx 装配错误是编程/装配问题（前置条件不满足），不应流进业务钩子：钩子只应
 * 面对合成正确的 ctx 做业务鉴权。顺序：ctx 校验门禁 → beforeToolCall → 白名单
 * → 执行半段（executeToolCall 的 input 校验 + ctx 二次校验为防御纵深）。
 *
 * 详见 authHooks.md「调用时序」与 runtime/agentToolContext.md「声明即校验强制点」。
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createAgentTestHarness, type AgentTestHarness } from '@faapi/faapi/testing';
import { Agent, type AgentDeps } from './agent';
import { createScriptLLM } from './scriptLlm';
import { createStandaloneToolContext } from './standaloneToolContext';

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

describe('executeTool 校验顺序——ctx 声明即校验先于 beforeToolCall', () => {
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

  it('ctx 装配错误：先于钩子拒绝——beforeToolCall 与 handler 均不被触达', async () => {
    const beforeToolCall = vi.fn(() => undefined);
    const afterToolCall = vi.fn(() => undefined);
    const deps = {
      ...makeDeps(createStandaloneToolContext()),
      config: { beforeToolCall, afterToolCall },
    };
    const agent = new Agent(deps);
    const llm = createScriptLLM([
      { toolCalls: [{ name: 'order_getOrder', arguments: { orderId: 'o1' } }] },
      { content: 'done' },
    ]);

    await agent.run('查订单', { agent: 'runner', provider: llm });

    expect(beforeToolCall).not.toHaveBeenCalled();
    expect(afterToolCall).not.toHaveBeenCalled();
  });

  it('ctx 完整：钩子在 handler 前正常调用（守卫语义不变）', async () => {
    const calls: string[] = [];
    const deps = {
      ...makeDeps(createStandaloneToolContext({ currentUserId: 42 })),
      config: {
        beforeToolCall: vi.fn(() => {
          calls.push('guard');
        }),
        afterToolCall: vi.fn(() => {
          calls.push('after');
        }),
      },
    };
    const agent = new Agent(deps);
    const llm = createScriptLLM([
      { toolCalls: [{ name: 'order_getOrder', arguments: { orderId: 'o1' } }] },
      { content: 'done' },
    ]);

    await agent.run('查订单', { agent: 'runner', provider: llm });

    expect(calls).toEqual(['guard', 'after']);
    expect(deps.config.beforeToolCall).toHaveBeenCalledWith(
      'order_getOrder',
      { orderId: 'o1' },
      expect.objectContaining({ currentUserId: 42 }),
    );
  });
});
