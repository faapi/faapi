/**
 * 隔离任务 agent 通道 e2e——真实 worker 线程 + 单次 agent-run RPC（宿主执行循环）
 *
 * worker 侧 `taskCtx.agent.run` 仅转发请求（run-only 代理，workerEntry 自包含，
 * 不动态加载 @faapi/agent）；编排循环收敛宿主：`onAgentRun` 以任务合成契约 ctx
 * （carry 合成 currentUserId）构造 Agent 跑完整循环——LLM IO、工具执行、鉴权钩子、
 * 输入组装钩子全在宿主（db 连接池等资源单实例、业务函数零跨线程）。
 *
 * 覆盖（三条都是真实 worker 线程 + 真实 @faapi/agent 插件 runner，仅 LLM 端点 mock）：
 * 1. 工具与守卫在宿主执行（carry 身份传导）——beforeToolCall 守卫 / handler marker /
 *    afterToolCall 审计同轮触发；循环结果按 agent-run-result 回传 worker 收敛
 * 2. resolveRootInput 钩子（decorateDeps 接线）在宿主生效——LLM 请求消息含钩子
 *    组装的输入与任务合成 ctx 身份（carry 身份可读）
 * 3. Input 校验失败以任务错误浮出——声明 Input 的 agent 派发形态对象入参校验不过，
 *    runAgent 抛 AgentError → RPC ok:false → worker 侧 reject → 任务失败（真实 zod.js
 *    产物加载 + safeParse，非 mock 校验）
 *
 * 详见 agentDeps.md「隔离任务通道」与 taskToolContext.md 三路径填充规则。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { Server } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { runTaskInWorker } from '@faapi/faapi/src/tasks/taskWorker';
import { createAppRegistries, createLogger, createTaskToolContext } from '@faapi/faapi';
import type { AgentMetadata, LlmConfig, PluginContext, ToolMetadata } from '@faapi/faapi';
import agentPlugin from './plugin';
import type { AgentDeps } from './agent';
import type { AgentRunner } from '@faapi/faapi';

// 宿主侧 provider fetch 走本机 127.0.0.1——绕过开发机代理（同主包 e2e 约定）
{
  const targets = ['localhost', '127.0.0.1'];
  const existing = (process.env.NO_PROXY ?? '').split(',').map((s) => s.trim());
  const merged = Array.from(new Set([...targets, ...existing])).filter(Boolean);
  process.env.NO_PROXY = merged.join(',');
  process.env.no_proxy = merged.join(',');
}

interface CapturedLlmRequest {
  messages: Array<{ role: string; content: string }>;
}

/** OpenAI chat completions 形响应的 mock LLM（按请求次序轮换 + 请求体捕获） */
function startMockLlm(
  responses: unknown[],
): Promise<{ server: Server; baseURL: string; requests: CapturedLlmRequest[] }> {
  let n = 0;
  const requests: CapturedLlmRequest[] = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body) as { messages?: CapturedLlmRequest['messages'] };
          requests.push({ messages: parsed.messages ?? [] });
        } catch {
          requests.push({ messages: [] });
        }
        const resp = responses[Math.min(n, responses.length - 1)]!;
        n += 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(resp));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ server, baseURL: `http://127.0.0.1:${addr.port}/v1`, requests });
    });
  });
}

/** 临时目录放 workspace 内——zod.js 的 `import 'zod'` 需向上解析到 packages/agent/node_modules */
describe('隔离任务 agent 通道（真实 worker 线程 + 单次 agent-run RPC 宿主执行）', () => {
  let dir: string;
  let markerPath: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(path.resolve(__dirname, '..'), '.e2e-agent-isolated-'));
    markerPath = path.join(dir, 'marker.txt');
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
    // 隔离任务模块（worker 侧仅转发 agent-run——编排循环在宿主）
    fs.writeFileSync(
      path.join(dir, 'task-run.js'),
      [
        'export async function run(payload, taskCtx) {',
        "  if (!taskCtx.agent) throw new Error('taskCtx.agent missing (agentChannel off?)');",
        '  const result = await taskCtx.agent.run(payload.input, { agent: payload.agentName, model: payload.model });',
        '  return { content: result.content };',
        '}',
      ].join('\n'),
      'utf-8',
    );
    // 派发形态对象入参（Input 校验用例：city 传数字必失败）
    fs.writeFileSync(
      path.join(dir, 'task-invalid.js'),
      [
        'export async function run(_payload, taskCtx) {',
        '  const result = await taskCtx.agent.run({ city: 123 }, { agent: "assistant", model: "gpt-4o" });',
        '  return { content: result.content };',
        '}',
      ].join('\n'),
      'utf-8',
    );
    // agent Input 的 zod.js 产物（generateAgentArtifacts 同款约定：与声明文件同级，
    // 导出 `InputSchema`）——真实加载 + safeParse，非 mock 校验
    fs.writeFileSync(
      path.join(dir, 'zod.js'),
      [
        "import { z } from 'zod';",
        'export const InputSchema = z.object({ city: z.string() });',
      ].join('\n'),
      'utf-8',
    );
  });

  afterAll(() => {
    delete process.env.AGENT_E2E_MARKER;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** 真实 @faapi/agent 插件 setup（生产装配路径）——返回宿主侧 agentRunner */
  function setupHost(llms: Record<string, LlmConfig>, meta: AgentMetadata, tools: ToolMetadata[]) {
    const ctx = {
      rootDir: dir,
      registries: createAppRegistries(),
      routes: [],
      getRoutes: () => [],
      server: {} as Server,
      config: { agent: { llms, maxTurns: 5 } },
      options: undefined,
    } as unknown as PluginContext;
    ctx.registries.agent.hydrate([meta]);
    ctx.registries.tool.hydrate(tools);
    agentPlugin.setup(ctx);
    const runner = ctx.registries.agentRunner.get();
    if (!runner) throw new Error('agentRunner not registered by plugin setup');
    return runner as AgentRunner;
  }

  /** 宿主执行 ctx：与生产同配方（createTaskToolContext——carry 字段 + 契约字段） */
  function buildOnAgentRun(runner: AgentRunner) {
    let hostCtx: unknown;
    return (request: { agentName: string; input?: unknown; options?: Record<string, unknown> }) => {
      hostCtx ??= createTaskToolContext({
        carry: { currentUserId: 42 },
        tasks: {} as never, // 本 e2e 工具不触任务队列——占位（生产为 scoped TaskClient）
        log: createLogger('task:weather-task'),
        signal: new AbortController().signal,
      });
      return runner.runAgent(
        hostCtx as Parameters<AgentRunner['runAgent']>[0],
        request as Parameters<AgentRunner['runAgent']>[1],
      );
    };
  }

  it('工具与守卫在宿主执行（carry 身份传导），worker 仅转发 agent-run', async () => {
    const mockLlm = await startMockLlm([
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
    const runner = setupHost(llms, agentMeta, [toolMeta]);

    const result = await runTaskInWorker({
      taskModulePath: path.join(dir, 'task-run.js'),
      payload: { input: 'weather?', agentName: 'assistant', model: 'gpt-4o' },
      taskCtx: {
        job: { id: 'j1', name: 'weather-task', attempt: 1 },
        carry: { currentUserId: 42 },
      },
      timeoutMs: 20000,
      // 注册表快照：worker 侧只读查询用（循环在宿主，真实声明不跨线程）
      registries: { agents: [agentMeta], tools: [toolMeta] },
      log: {
        scope: 'task:weather-task',
        fields: { jobId: 'j1', task: 'weather-task', attempt: 1 },
      },
      onAgentRun: buildOnAgentRun(runner),
    });

    // 编排循环在宿主完成：工具结果回传 LLM 后收敛，结果经 agent-run-result 回 worker
    expect(result).toEqual({ content: 'done' });
    // 工具 handler 在宿主执行：marker 写入，ctx.currentUserId 来自宿主合成 ctx
    const marker = fs.readFileSync(markerPath, 'utf8').trim();
    expect(JSON.parse(marker)).toEqual({ city: '北京', userId: 42 });
    // 宿主守卫/审计（config 钩子在宿主 executeToolCall 内触发）
    expect(mockLlm.requests).toHaveLength(2);
    mockLlm.server.close();
  }, 25000);

  it('resolveRootInput 钩子（decorateDeps 接线）在宿主生效（钩子不可克隆但循环在宿主）', async () => {
    const mockLlm = await startMockLlm([
      { choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] },
    ]);
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
    };
    // 钩子引用宿主闭包（读 ctx 身份）——不可跨线程；循环在宿主，全量可见。
    // decorateDeps 由插件 setup 经 createAgentDeps 应用（config 声明钩子的生产路径）
    const ctx = {
      rootDir: dir,
      registries: createAppRegistries(),
      routes: [],
      getRoutes: () => [],
      server: {} as Server,
      config: {
        agent: {
          llms,
          maxTurns: 5,
          decorateDeps: (deps: AgentDeps): AgentDeps => ({
            ...deps,
            resolveRootInput: async (_name, input, hookCtx) =>
              `${input}\n\n[宿主注入:${(hookCtx as { currentUserId?: number }).currentUserId}]`,
          }),
        },
      },
      options: undefined,
    } as unknown as PluginContext;
    ctx.registries.agent.hydrate([agentMeta]);
    ctx.registries.tool.hydrate([toolMeta]);
    agentPlugin.setup(ctx);
    const runner = ctx.registries.agentRunner.get() as AgentRunner;

    await runTaskInWorker({
      taskModulePath: path.join(dir, 'task-run.js'),
      payload: { input: 'weather?', agentName: 'assistant', model: 'gpt-4o' },
      taskCtx: {
        job: { id: 'j2', name: 'weather-task', attempt: 1 },
        carry: { currentUserId: 42 },
      },
      timeoutMs: 20000,
      registries: {
        agents: [agentMeta],
        tools: [toolMeta],
      },
      log: {
        scope: 'task:weather-task',
        fields: { jobId: 'j2', task: 'weather-task', attempt: 1 },
      },
      onAgentRun: buildOnAgentRun(runner),
    });

    // LLM 请求消息含钩子组装的输入（ctx 为宿主任务合成契约 ctx，carry 身份可读）
    const messagesJson = JSON.stringify(mockLlm.requests[0]?.messages ?? []);
    expect(messagesJson).toContain('weather?');
    expect(messagesJson).toContain('宿主注入:42');
    mockLlm.server.close();
  }, 25000);

  it('Input 校验失败以任务错误浮出（真实 zod.js 产物 safeParse → RPC ok:false → worker reject）', async () => {
    const mockLlm = await startMockLlm([
      { choices: [{ message: { role: 'assistant', content: 'never' }, finish_reason: 'stop' }] },
    ]);
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
      inputTypeName: 'Input',
    };
    const runner = setupHost(llms, agentMeta, [toolMeta]);

    // 对象入参 { city: 123 } 违反 zod.js 的 city: z.string()——runAgent 抛 AgentError，
    // RPC ok:false 回传 worker，taskCtx.agent.run reject → 任务以该错误失败
    await expect(
      runTaskInWorker({
        taskModulePath: path.join(dir, 'task-invalid.js'),
        payload: {},
        taskCtx: {
          job: { id: 'j3', name: 'weather-task', attempt: 1 },
          carry: { currentUserId: 42 },
        },
        timeoutMs: 20000,
        registries: { agents: [agentMeta], tools: [toolMeta] },
        log: {
          scope: 'task:weather-task',
          fields: { jobId: 'j3', task: 'weather-task', attempt: 1 },
        },
        onAgentRun: buildOnAgentRun(runner),
      }),
    ).rejects.toThrow(/input validation failed/);
    // 校验在宿主 runAgent 内短路——循环未起，零 LLM 调用
    expect(mockLlm.requests).toHaveLength(0);
    mockLlm.server.close();
  }, 25000);
});
