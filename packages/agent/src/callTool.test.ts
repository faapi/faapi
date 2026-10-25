/**
 * callTool 测试——经真实分发管线的 tool 测试辅助函数行为定义
 *
 * fixture 项目在临时目录搭建（含 ctx 声明 tool 与无 ctx 声明 tool），
 * 覆盖：ctx 声明即校验在测试路径生效（缺业务字段响亮抛错——租户隔离穿底的
 * 复现用例）、input 校验 { error } 原样返回、free-form 显式抛错、tool 不存在。
 *
 * 详见 [callTool.md](./callTool.md)。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAgentTestHarness, type AgentTestHarness } from '@faapi/faapi/testing';
import { createStandaloneToolContext } from './standaloneToolContext';
import { callTool } from './callTool';

// ─── fixture 项目搭建 ─────────────────────────────────────────────

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

  // tool：第二参声明业务校验类型（ctxTypeName = OrderCtx）——ctx 声明即校验用例
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

  // tool：无第二参声明（无 ctxTypeName）——不校验用例
  w(
    'src/tools/calc/handler.ts',
    `export interface CalcInput {
  base: number;
}

export function calc(input: CalcInput) {
  return { total: input.base * 2 };
}
`,
  );
}

describe('callTool', () => {
  let projectRoot: string;
  let h: AgentTestHarness;

  beforeAll(async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'faapi-call-tool-'));
    writeProject(projectRoot);
    h = await createAgentTestHarness({ rootDir: projectRoot, schemaMode: 'generated' });
  });

  afterAll(async () => {
    await h.close();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('ctx 完整：经 executeToolCall 真实分发，业务字段传导到 handler', async () => {
    const ctx = createStandaloneToolContext({ currentUserId: 42 });
    const result = (await callTool(h, 'order_getOrder', { orderId: 'o1' }, ctx)) as {
      orderId: string;
      userId: number;
    };
    expect(result).toEqual({ orderId: 'o1', userId: 42 });
  });

  it('ctx 缺业务字段：响亮抛错（租户隔离穿底复现用例——不得以 { error } 静默放行）', async () => {
    const ctx = createStandaloneToolContext();
    await expect(callTool(h, 'order_getOrder', { orderId: 'o1' }, ctx)).rejects.toThrow(
      /ctx 校验失败/,
    );
  });

  it('ctx 业务字段错型：抛错', async () => {
    const ctx = createStandaloneToolContext({ currentUserId: 'not-a-number' });
    await expect(callTool(h, 'order_getOrder', { orderId: 'o1' }, ctx)).rejects.toThrow(
      /ctx 校验失败/,
    );
  });

  it('ctx 缺席（undefined）：抛错', async () => {
    await expect(
      callTool(h, 'order_getOrder', { orderId: 'o1' }, undefined as never),
    ).rejects.toThrow(/ctx 校验失败/);
  });

  it('input 校验失败：返回 { error }（与 LLM 重试语义一致，可断言）', async () => {
    const ctx = createStandaloneToolContext({ currentUserId: 1 });
    const result = (await callTool(h, 'order_getOrder', { orderId: 123 }, ctx)) as {
      error: string;
    };
    expect(result.error).toBeTruthy();
  });

  it('无 ctx 声明的 tool：ctx 原样透传不校验（缺业务字段也放行——口径与分发路径一致）', async () => {
    const ctx = createStandaloneToolContext();
    const result = (await callTool(h, 'calc_calc', { base: 5 }, ctx)) as { total: number };
    expect(result.total).toBe(10);
  });

  it('tool 不存在：抛错', async () => {
    const ctx = createStandaloneToolContext();
    await expect(callTool(h, 'nope_missing', {}, ctx)).rejects.toThrow(/not found/);
  });

  it('free-form 模式：显式抛错指引 generated（无 schema 可校验，不静默放行）', async () => {
    const freeForm = await createAgentTestHarness({ rootDir: projectRoot });
    try {
      const ctx = createStandaloneToolContext({ currentUserId: 1 });
      await expect(callTool(freeForm, 'order_getOrder', { orderId: 'o1' }, ctx)).rejects.toThrow(
        /generated/,
      );
    } finally {
      await freeForm.close();
    }
  });
});
