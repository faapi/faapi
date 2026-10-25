/**
 * 隔离任务 agent 通道 e2e——真实 worker 线程全链路
 *
 * 覆盖：taskQueue 级 onAgentCall 分派（经 runTaskInWorker 的消息循环）→ worker 内
 * buildAgentChannel 动态组装（createAgentDeps + RPC 垫片）→ agent 编排循环在
 * worker 跑（mock LLM）→ 工具调用 / 鉴权钩子回传宿主执行（executeToolCall）→
 * 结果按 seq 回传 worker 续跑。
 *
 * 仅 LLM 端点是 mock（本地 node:http 回 OpenAI 形响应），RPC 边界、worker 线程、
 * deps 组装、宿主执行全部真实。工具在宿主执行的证据：宿主 beforeToolCall 守卫与
 * handler marker 同轮触发（守卫只存在于宿主 executeToolCall 内），ctx 携带 carry
 * 合成的 currentUserId。
 *
 * 详见 agentDeps.md「隔离任务通道」与 agentToolContext.md 三路径填充规则。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { Server } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runTaskInWorker } from '@faapi/faapi/src/tasks/taskWorker';
import { createTaskToolContext } from '@faapi/faapi';
import { createLogger } from '@faapi/faapi';
import { executeToolCall, type AgentDeps } from './agent';
import type { ToolMetadata, AgentMetadata, LlmConfig } from '@faapi/faapi';

// worker 内 provider fetch 走本机 127.0.0.1——绕过开发机代理（同主包 e2e 约定）
{
  const targets = ['localhost', '127.0.0.1'];
  const existing = (process.env.NO_PROXY ?? '').split(',').map((s) => s.trim());
  const merged = Array.from(new Set([...targets, ...existing])).filter(Boolean);
  process.env.NO_PROXY = merged.join(',');
  process.env.no_proxy = merged.join(',');
}

/** OpenAI chat completions 形响应的 mock LLM（按请求次序轮换） */
function startMockLlm(responses: unknown[]): Promise<{ server: Server; baseURL: string }> {
  let n = 0;
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      const body = responses[Math.min(n, responses.length - 1)]!;
      n += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ server, baseURL: `http://127.0.0.1:${addr.port}/v1` });
    });
  });
}

// ─── worker 可加载的 @faapi/agent bundle（monorepo 测试环境专用） ────────
//
// worker 线程经 plain Node 动态加载 agent 包（workerEntry 自包含约束，不走
// vitest alias）。monorepo 里 dev exports 指向 TS 源（extensionless，Node 不可
// 加载）——e2e 用 esbuild 把 agent src（连同主包 src 值依赖）打包到
// packages/faapi/node_modules/.faapi-agent-e2e-bundle/（node_modules gitignore，
// 目录名不含 '@faapi/agent'——与裸说明符解析零碰撞，主包测试不受影响），
// 经 runTaskInWorker 的 agentModuleUrl 注入（可注入覆盖，生产走裸说明符解析
// 业务方安装的 dist 包）。@faapi/faapi 值依赖 inline（esbuild 原生 TS 加载
// 主包 src）；主包运行时依赖 external——bundle 位置向上即 packages/faapi/
// node_modules，全部可解析。

const E2E_BUNDLE_DIR = path.resolve(__dirname, '../../faapi/node_modules/.faapi-agent-e2e-bundle');

async function buildAgentBundle(): Promise<string> {
  const esbuild = (await import(
    pathToFileURL(path.resolve(__dirname, '../../faapi/node_modules/esbuild/lib/main.js')).href
  )) as unknown as {
    build: (options: Record<string, unknown>) => Promise<unknown>;
  };
  fs.mkdirSync(E2E_BUNDLE_DIR, { recursive: true });
  const outfile = path.join(E2E_BUNDLE_DIR, 'index.js');
  await esbuild.build({
    entryPoints: [path.resolve(__dirname, 'index.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node24',
    outfile,
    external: ['node:*', 'zod', 'croner', 'esbuild', 'fast-glob', 'typescript', 'ws'],
  });
  return pathToFileURL(outfile).href;
}

describe('隔离任务 agent 通道（真实 worker 线程 + RPC 宿主执行）', () => {
  let mockLlm: { server: Server; baseURL: string };
  let dir: string;

  beforeAll(async () => {
    mockLlm = await startMockLlm([
      // 轮 1：请求工具调用
      {
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'c1',
                  type: 'function',
                  function: { name: 'test_weather', arguments: '{"city":"北京"}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
      // 轮 2：消费工具结果收敛
      { choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }] },
    ]);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faapi-agent-isolated-'));
    fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}', 'utf-8');
    // 工具 handler 模块（宿主执行——写 marker 证明执行发生与 ctx 身份）
    fs.writeFileSync(
      path.join(dir, 'tool.js'),
      [
        "import { appendFileSync } from 'node:fs';",
        'export async function handler(args, ctx) {',
        '  appendFileSync(process.env.AGENT_E2E_MARKER, JSON.stringify({ city: args.city, userId: ctx.currentUserId }) + "\\n");',
        "  return { weather: '晴' };",
        '}',
      ].join('\n'),
      'utf-8',
    );
    // 隔离任务模块（worker 侧执行——编排循环，工具经 RPC 宿主执行）
    fs.writeFileSync(
      path.join(dir, 'task.js'),
      [
        'export async function run(payload, taskCtx) {',
        "  if (!taskCtx.agent) throw new Error('taskCtx.agent missing (agentChannel off?)');",
        '  const result = await taskCtx.agent.run("weather?", { agent: "assistant", model: "gpt-4o" });',
        '  return { content: result.content };',
        '}',
      ].join('\n'),
      'utf-8',
    );
  });

  afterAll(() => {
    delete process.env.AGENT_E2E_MARKER;
    mockLlm.server.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(E2E_BUNDLE_DIR, { recursive: true, force: true });
  });

  it('工具与守卫在宿主执行（carry 身份传导），编排循环在 worker 完成', async () => {
    const markerPath = path.join(dir, 'marker.txt');
    process.env.AGENT_E2E_MARKER = markerPath;
    const llms: Record<string, LlmConfig> = {
      openai: {
        provider: 'openai',
        apiKey: 'sk-e2e',
        baseURL: mockLlm.baseURL,
        models: { 'gpt-4o': {} },
      },
    };
    const toolMeta: ToolMetadata = {
      name: 'test_weather',
      functionName: 'handler',
      filePath: path.join(dir, 'tool.js'),
    };
    const agentMeta: AgentMetadata = {
      name: 'assistant',
      filePath: path.join(dir, 'agent.js'),
      systemPrompt: '你是天气助手',
      tools: ['test_weather'],
    };

    // 宿主侧守卫/审计记录（守卫只存在于宿主 executeToolCall——触发即宿主执行证据）
    const guardCalls: Array<{ name: string; userId: unknown }> = [];
    const afterCalls: string[] = [];
    const toolMap = new Map([[toolMeta.name, toolMeta]]);
    const hostDeps = {
      providers: new Map(),
      llms: {},
      rootDir: dir,
      getTool: (name: string) => toolMap.get(name),
      loadToolModule: async (filePath: string) => {
        const mod = (await import(pathToFileURL(filePath).href)) as {
          handler: (args: unknown, ctx: unknown) => Promise<unknown>;
        };
        return { functionName: 'handler', handler: mod.handler };
      },
      config: {
        afterToolCall: (name: string) => {
          afterCalls.push(name);
        },
      },
    } as unknown as AgentDeps;

    const runnerSchemaCache = new Map<string, unknown>();
    // 宿主执行器（e2e 手工形态——生产由 @faapi/agent 插件注册到 agentToolRunner）
    const runner = {
      beforeToolCall: async (ctx: unknown, toolName: string, _args: Record<string, unknown>) => {
        guardCalls.push({
          name: toolName,
          userId: (ctx as { currentUserId?: number }).currentUserId,
        });
        return undefined;
      },
      toolCall: (ctx: unknown, toolName: string, args: Record<string, unknown>) =>
        executeToolCall(
          hostDeps,
          toolName,
          args,
          ctx as Parameters<typeof executeToolCall>[3],
          runnerSchemaCache as never,
        ),
      filterTools: async (_ctx: unknown, tools: unknown[]) => tools,
      resolveSubAgentInput: async () => undefined,
      resolveSubAgentContext: async () => undefined,
      // 宿主无 reminders 声明（config 快照未配置 agent.reminders）——undefined
      resolveReminders: async () => undefined,
    };

    // 宿主执行 ctx：与生产同配方（createTaskToolContext——carry 字段 + 契约字段）
    let hostCtx: unknown;
    const onAgentCallInner = async (kind: string, payload: Record<string, unknown>) => {
      hostCtx ??= createTaskToolContext({
        carry: { currentUserId: 42 },
        tasks: {} as never, // 本 e2e 工具不触任务队列——占位（生产为 scoped TaskClient）
        log: createLogger('task:weather-task'),
        signal: new AbortController().signal,
      });
      const p = payload as {
        toolName?: string;
        args?: Record<string, unknown>;
        tools?: unknown[];
        subName?: string;
        agentName?: string;
        depth?: number;
        turn?: number;
        phase?: string;
      };
      switch (kind) {
        case 'before-tool-call':
          return runner.beforeToolCall(hostCtx, p.toolName!, p.args ?? {});
        case 'tool-call':
          return runner.toolCall(hostCtx, p.toolName!, p.args ?? {});
        case 'filter-tools':
          return runner.filterTools(hostCtx, p.tools ?? []);
        case 'resolve-sub-agent-input':
          return runner.resolveSubAgentInput(hostCtx, p.subName!, p.args ?? {});
        case 'resolve-sub-agent-context':
          return runner.resolveSubAgentContext(hostCtx, p.subName!, p.args ?? {});
        case 'resolve-reminders':
          return runner.resolveReminders(hostCtx, {
            agentName: p.agentName!,
            depth: p.depth ?? 0,
            turn: p.turn ?? 0,
            phase: p.phase === 'everyTurn' ? 'everyTurn' : 'once',
          });
        default:
          throw new Error(`unexpected kind ${kind}`);
      }
    };
    const onAgentCall = onAgentCallInner;

    const result = await runTaskInWorker({
      taskModulePath: path.join(dir, 'task.js'),
      rootDir: dir,
      agentModuleUrl: await buildAgentBundle(),
      payload: { markerPath },
      taskCtx: {
        job: { id: 'j1', name: 'weather-task', attempt: 1 },
        // config 纯数据快照：worker 内 agentConfig 读 .agent（llms → providers）
        config: { agent: { llms, maxTurns: 5 } },
        carry: { currentUserId: 42 },
      },
      timeoutMs: 20000,
      registries: { agents: [agentMeta], tools: [toolMeta] },
      llms,
      log: {
        scope: 'task:weather-task',
        fields: { jobId: 'j1', task: 'weather-task', attempt: 1 },
      },
      onAgentCall,
    });

    // 编排循环在 worker 完成：工具结果回传 LLM 后收敛
    expect(result).toEqual({ content: 'done' });
    // 守卫在宿主触发，ctx 携带 carry 合成身份
    expect(guardCalls).toEqual([{ name: 'test_weather', userId: 42 }]);
    // afterToolCall 审计在宿主触发
    expect(afterCalls).toEqual(['test_weather']);
    // 工具 handler 在宿主执行：marker 写入，ctx.currentUserId 来自宿主合成 ctx
    const marker = fs.readFileSync(markerPath, 'utf8').trim();
    expect(JSON.parse(marker)).toEqual({ city: '北京', userId: 42 });
  }, 25000);
});
