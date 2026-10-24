import { describe, it, expect } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { createContext, createTestContext } from './createContext';
import {
  createThrowingTaskClient,
  toAgentToolContext,
  type AgentToolContext,
} from './agentToolContext';

describe('toAgentToolContext', () => {
  it('契约字段全部在场：tasks/log/signal 与源 ctx 同引用', () => {
    const ctx = createTestContext({ path: '/api/user' });
    // 模拟 app 编排：createTestContext 传入 registries 时 ctx.tasks 才有值；
    // 此处聚焦收窄行为，tasks 用最小桩满足契约形状
    const tasks = { enqueue: async () => ({}) } as unknown as NonNullable<
      AgentToolContext['tasks']
    >;
    ctx.tasks = tasks;

    const toolCtx = toAgentToolContext(ctx);

    expect(toolCtx.tasks).toBe(tasks);
    expect(toolCtx.log).toBe(ctx.log);
    expect(toolCtx.signal).toBe(ctx.signal);
  });

  it('ctx 上的业务增强字段原样透传（顶层可读）', () => {
    const ctx = createTestContext({ path: '/api/user' });
    ctx.tasks = { enqueue: async () => ({}) } as unknown as NonNullable<AgentToolContext['tasks']>;
    // 业务经中间件/FaapiContext 增强塞进 ctx 的身份字段——框架对非契约字段只透传不生产
    (ctx as unknown as Record<string, unknown>).currentUserId = 7;

    const toolCtx = toAgentToolContext(ctx) as AgentToolContext & { currentUserId?: number };

    expect(toolCtx.currentUserId).toBe(7);
  });

  it('无队列编排的 ctx（createContext 填充的抛错桩）原样透传：调用即显式失败', () => {
    const ctx = createTestContext({ path: '/api/user' });
    // 无 registries 时 ctx.tasks 已由 createContext 填充为抛错桩（字段恒在）
    expect(ctx.tasks).toBeDefined();

    const toolCtx = toAgentToolContext(ctx);
    expect(toolCtx.tasks).toBe(ctx.tasks);
    expect(() =>
      (
        toolCtx.tasks as unknown as { enqueue: (n: string, p: unknown) => Promise<unknown> }
      ).enqueue('x', {}),
    ).toThrow(/无任务队列/);
  });
});

describe('createThrowingTaskClient（抛错桩）', () => {
  it('then 返回 undefined：桩被透传时 await 不误触（thenable 检查安全）', async () => {
    const stub = createThrowingTaskClient();
    // handler return ctx.tasks 等透传场景——await 链路的 thenable 检查不得触发桩错误
    const passthrough = await Promise.resolve(stub);
    expect(passthrough).toBe(stub);
  });

  it('方法调用显式抛错并含修复指引', () => {
    const stub = createThrowingTaskClient();
    expect(() => (stub as unknown as { list: () => Promise<unknown> }).list()).toThrow(
      /无任务队列/,
    );
  });
});

describe('AgentToolContext 契约（FaapiContext.signal 接线）', () => {
  it('FaapiContext.signal 从 request.signal 接线（同引用）', () => {
    const ctx = createTestContext({ path: '/api/user' });
    expect(ctx.signal).toBeInstanceOf(AbortSignal);
    expect(ctx.signal).toBe(ctx.request.signal);
  });

  it('客户端断开传播：request abort 后 ctx.signal.aborted 为 true', () => {
    const controller = new AbortController();
    const request = new Request('http://localhost/api/user', { signal: controller.signal });
    const ctx = createContext(request, {});

    expect(ctx.signal.aborted).toBe(false);
    controller.abort();
    expect(ctx.signal.aborted).toBe(true);
  });
});

describe('AgentToolContext 拒绝 declare module 增强（type alias 边界）', () => {
  it('业务侧 declare module 增强声明报 TS2300（防止改回 interface 的回归）', () => {
    const tempDir = join(
      tmpdir(),
      `faapi-augment-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tempDir, { recursive: true });
    try {
      // 增强目标：真实的框架契约文件（同目录 import.meta 定位）——若有人把
      // type alias 改回 interface，本用例因 2300 消失而失败
      const targetPath = fileURLToPath(new URL('./agentToolContext.ts', import.meta.url));
      // import 与 declare module 必须用同一 specifier 字符串才能命中同一模块；
      // 去掉 .ts 扩展名（Bundler 解析下带扩展名的 .ts 导入需 allowImportingTsExtensions）
      let specifier = relative(tempDir, targetPath).split(sep).join('/');
      specifier = specifier.replace(/\.ts$/, '');
      if (!specifier.startsWith('.')) specifier = `./${specifier}`;

      const entryPath = join(tempDir, 'entry.ts');
      writeFileSync(
        entryPath,
        `import type { AgentToolContext } from '${specifier}';\n` +
          `declare module '${specifier}' {\n` +
          `  interface AgentToolContext {\n    ghost?: number;\n  }\n` +
          `}\n` +
          `export {};\n`,
      );

      const program = ts.createProgram([entryPath], {
        noEmit: true,
        strict: true,
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
      });
      // 带文件参数的调用在当前 TS 构建下行为异常，取全量语义诊断后过滤
      const duplicates = program
        .getSemanticDiagnostics()
        .filter(
          (d) =>
            d.code === 2300 &&
            ts.flattenDiagnosticMessageText(d.messageText, ' ').includes('AgentToolContext'),
        );
      expect(duplicates.length).toBeGreaterThan(0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
