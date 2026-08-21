/**
 * multi-agent demo e2e 测试
 *
 * 验证完整流程：fixtures 编译 → createProdApp 水合 registries →
 * agentHandleFactory 注册 → app.inject() → handler → agent.run() →
 * tool 调用 + sub-agent 递归。
 *
 * LLM provider 用 mock（按序列返回预设响应），避免真实 API 调用。
 * agentHandleFactory 手动注册（不依赖 @faapi/agent 插件自动加载，
 * 插件加载逻辑已在 plugin.test.ts 覆盖）。
 *
 * 详见 [README.md](../README.md) Phase 3.6。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// @faapi/faapi 公开 API
import {
  createProdApp,
  registerAgentHandleFactory,
  clearAgentHandleFactory,
  getAgent,
  getTool,
  resolveAgentTools,
  resolveSubAgents,
  loadAgentModule,
  loadToolModule,
  loadToolSchema,
} from '@faapi/faapi';

// @faapi/faapi 内部模块（深路径，e2e 测试专用，tsc 通过 exclude 跳过检查）
import { compileDevRoutes } from '@faapi/faapi/src/cli/compileDevRoutes';
import { compileConfig } from '@faapi/faapi/src/cli/compileConfig';
import { scanRoutes } from '@faapi/faapi/src/router/scanRoutes';
import { sortRoutes } from '@faapi/faapi/src/router/sortRoutes';
import { serializeRoutes, writeRoutesModule } from '@faapi/faapi/src/cli/generateRoutes';
import { generateSchemaFiles } from '@faapi/faapi/src/cli/generateSchemaFiles';
import { scanAgents } from '@faapi/faapi/src/agents/scanAgents';
import { generateAgentArtifacts } from '@faapi/faapi/src/cli/generateAgentArtifacts';
import { scanTools } from '@faapi/faapi/src/tools/scanTools';
import { generateToolArtifacts } from '@faapi/faapi/src/cli/generateToolArtifacts';
import { invalidateMiddlewareCache } from '@faapi/faapi/src/middleware/loadMiddlewares';
import { invalidateProgramCache } from '@faapi/faapi/src/ast/createProgram';
import { invalidateSchemaCache } from '@faapi/faapi/src/validator/validateInput';

// @faapi/agent
import { Agent } from './agent';
import type { AgentDeps, ToolSchemaResolution } from './agent';
import type { LLMProvider, LLMResponse, LLMMessage, LLMStopReason } from './provider';
import { z } from 'zod';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.resolve(__dirname, '../fixtures/multi-agent-demo');

// ─── Mock LLM Provider 构造器 ─────────────────────────

/** 构造 LLMResponse（complete 模式） */
function llmResponse(opts: {
  content?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  stopReason?: LLMStopReason;
}): LLMResponse {
  const message: LLMMessage = {
    role: 'assistant',
    content: opts.content ?? '',
  };
  if (opts.toolCalls && opts.toolCalls.length > 0) {
    message.toolCalls = opts.toolCalls;
  }
  return {
    message,
    stopReason: opts.stopReason ?? (opts.toolCalls ? 'tool_calls' : 'stop'),
  };
}

/** 创建 mock LLMProvider（complete 按序列返回，记录每次请求） */
function createMockProvider(responses: LLMResponse[]): {
  provider: LLMProvider;
  requests: LLMResponse[];
  completeRequests: import('./provider').LLMCompleteRequest[];
} {
  let index = 0;
  const completeRequests: import('./provider').LLMCompleteRequest[] = [];
  const provider: LLMProvider = {
    complete: async (request) => {
      completeRequests.push(request);
      const res = responses[index++];
      if (!res) throw new Error('No more mock responses');
      return res;
    },
    stream: () => {
      throw new Error('stream not mocked');
    },
  };
  return { provider, requests: responses, completeRequests };
}

// ─── E2E 测试 ─────────────────────────────────────────

describe('multi-agent demo e2e', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(
      tmpdir(),
      `faapi-agent-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tempDir, { recursive: true });
    cpSync(FIXTURES_DIR, tempDir, { recursive: true });
    invalidateMiddlewareCache();
    invalidateProgramCache();
  });

  afterEach(async () => {
    invalidateSchemaCache();
    invalidateMiddlewareCache();
    invalidateProgramCache();
    clearAgentHandleFactory();
    rmSync(tempDir, { recursive: true, force: true });
  });

  /**
   * 编译 fixtures 产物（与 faapi build 一致）
   *
   * 生成 dist 下：
   * - 各 handler.js（路由 + agent + tool 编译产物）
   * - faapi-config.js（配置入口）
   * - faapi-routes.js（路由清单）
   * - faapi-agents.js（agent 清单）
   * - faapi-tools.js（tool 清单）
   * - 各 handler 同级的 zod.js（schema 模块）
   */
  async function compileArtifacts(): Promise<void> {
    // 1. 逐文件编译 .ts → dist/**/*.js
    await compileDevRoutes({ rootDir: tempDir, dist: 'dist' });

    // 2. 编译 faapi.config.ts → dist/faapi-config.js
    await compileConfig({ rootDir: tempDir, dist: 'dist' });

    // 3. 扫描路由 + 生成 faapi-routes.js + zod.js
    const { routes, wsRoutes } = await scanRoutes(tempDir, ['src/api/**/*.ts'], 'dist');
    const sorted = sortRoutes(routes);
    const serialized = serializeRoutes(sorted, wsRoutes, tempDir, 'dist');
    await writeRoutesModule(serialized, join(tempDir, 'dist', 'faapi-routes.js'));
    await generateSchemaFiles(sorted, tempDir, 'dist');

    // 4. 扫描 agents + 生成 faapi-agents.js
    const agents = await scanAgents(tempDir, ['src/agents/*/handler.ts']);
    await generateAgentArtifacts(agents, tempDir, 'dist');

    // 5. 扫描 tools + 生成 faapi-tools.js + zod.js
    const tools = await scanTools(tempDir, ['src/tools/**/*.ts', 'src/agents/*/tools/**/*.ts']);
    await generateToolArtifacts(tools, tempDir, 'dist');
  }

  /**
   * 构造 AgentDeps（用 @faapi/faapi 导出的真实访问器）
   *
   * 与 @faapi/agent plugin.ts 的工厂逻辑对称，但 provider 用 mock。
   * resolveToolSchema 用 loadToolSchema + z.toJSONSchema + safeParse 实现
   *（与 plugin.ts 同构）。
   *
   * loadToolModule / loadAgentModule 的 filePath 转为绝对路径——
   * toolRegistry / agentRegistry 中的 filePath 是产物形式相对路径（如 `dist/tools/weather/handler.js`），
   * vitest 环境下 `importActual` 不解析 bare specifier，需拼接 rootDir 转绝对路径。
   */
  function makeAgentDeps(provider: LLMProvider): AgentDeps {
    const toAbs = (filePath: string): string =>
      path.isAbsolute(filePath) ? filePath : path.resolve(tempDir, filePath);
    return {
      provider,
      agentName: 'researcher',
      rootDir: tempDir,
      config: {
        maxTurns: 10,
        maxAgentDepth: 3,
        defaultTools: ['weather.getWeather'],
      },
      getAgent,
      getTool,
      resolveAgentTools,
      resolveSubAgents,
      loadToolModule: (filePath, functionName) =>
        loadToolModule(toAbs(filePath), functionName, tempDir),
      loadAgentModule: (filePath, hasConfig, hasRun) =>
        loadAgentModule(toAbs(filePath), hasConfig, hasRun, tempDir),
      // resolveToolSchema：加载 tool 的 zod.js → z.toJSONSchema + safeParse
      resolveToolSchema: async (tool) => {
        const schemaMod = await loadToolSchema(tool, tempDir);
        if (!schemaMod) return undefined;
        const schema = schemaMod.schema as z.ZodType;
        const resolution: ToolSchemaResolution = {
          jsonSchema: z.toJSONSchema(schema),
          validate: (input) => {
            const result = schema.safeParse(input);
            if (result.success) {
              return { ok: true as const, value: result.data as Record<string, unknown> };
            }
            return { ok: false as const, error: result.error.message };
          },
        };
        return resolution;
      },
    };
  }

  describe('fixtures 编译 + registries 水合', () => {
    it('编译产物生成完整（routes + agents + tools + config）', async () => {
      await compileArtifacts();

      // 验证关键产物存在
      const { existsSync } = await import('node:fs');
      expect(existsSync(join(tempDir, 'dist', 'faapi-routes.js'))).toBe(true);
      expect(existsSync(join(tempDir, 'dist', 'faapi-agents.js'))).toBe(true);
      expect(existsSync(join(tempDir, 'dist', 'faapi-tools.js'))).toBe(true);
      expect(existsSync(join(tempDir, 'dist', 'faapi-config.js'))).toBe(true);
    });

    it('createProdApp 水合 agentRegistry + toolRegistry', async () => {
      await compileArtifacts();

      const app = await createProdApp({ rootDir: tempDir });

      // 验证 agentRegistry 水合（researcher + writer）
      const researcher = getAgent('researcher');
      expect(researcher).toBeDefined();
      expect(researcher!.name).toBe('researcher');
      expect(researcher!.systemPrompt).toContain('研究助手');
      expect(researcher!.agents).toEqual(['writer']);
      expect(researcher!.tools).toEqual(['weather.getWeather', 'calculator.calc']);

      const writer = getAgent('writer');
      expect(writer).toBeDefined();
      expect(writer!.name).toBe('writer');
      expect(writer!.hasRun).toBe(true);

      // 验证 toolRegistry 水合（weather + calculator）
      const weather = getTool('weather.getWeather');
      expect(weather).toBeDefined();
      expect(weather!.functionName).toBe('getWeather');
      expect(weather!.inputTypeName).toBe('WeatherInput');

      const calculator = getTool('calculator.calc');
      expect(calculator).toBeDefined();
      expect(calculator!.functionName).toBe('calc');

      // 验证 resolveAgentTools（researcher 的可用 tool）
      const researcherTools = resolveAgentTools('researcher');
      const toolNames = researcherTools.map((t) => t.name);
      expect(toolNames).toContain('weather.getWeather');
      expect(toolNames).toContain('calculator.calc');

      // 验证 resolveSubAgents（researcher 可调用 writer）
      const subAgents = resolveSubAgents('researcher');
      expect(subAgents.map((a) => a.name)).toEqual(['writer']);

      await app.close();
    });
  });

  describe('agent.run() — tool 调用 + sub-agent 递归', () => {
    it('researcher 调 weather tool + writer sub-agent 后返回最终答案', async () => {
      await compileArtifacts();
      const app = await createProdApp({ rootDir: tempDir });

      // mock provider 响应序列：
      // 1. 调 weather.getWeather({ city: '北京' })
      // 2. 调 agent.writer({ topic: 'AI' })
      // 3. stop 返回最终答案
      const { provider, completeRequests } = createMockProvider([
        llmResponse({
          toolCalls: [{ id: 'c1', name: 'weather.getWeather', arguments: { city: '北京' } }],
        }),
        llmResponse({
          toolCalls: [{ id: 'c2', name: 'agent.writer', arguments: { topic: 'AI' } }],
        }),
        llmResponse({ content: '研究完成：北京 22 度晴，writer 生成了报告', stopReason: 'stop' }),
      ]);

      // 构造 Agent 实例（用真实 registries deps + mock provider）
      const deps = makeAgentDeps(provider);
      const agent = new Agent(deps);

      const result = await agent.run('查询北京天气并撰写关于 AI 的报告');

      // 验证最终结果
      expect(result.content).toBe('研究完成：北京 22 度晴，writer 生成了报告');
      expect(result.turns).toBe(3);
      expect(result.stopReason).toBe('stop');

      // 验证第1轮 LLM 收到 systemPrompt + tools
      const firstRequest = completeRequests[0];
      const systemMsg = firstRequest.messages.find((m) => m.role === 'system');
      expect(systemMsg?.content).toContain('研究助手');

      const toolNames = (firstRequest.tools ?? []).map((t) => t.name);
      expect(toolNames).toContain('weather.getWeather');
      expect(toolNames).toContain('calculator.calc');
      expect(toolNames).toContain('agent.writer');

      // 验证第2轮 LLM 收到 weather tool 结果
      const secondRequest = completeRequests[1];
      const weatherResultMsg = secondRequest.messages.find((m) => m.role === 'tool');
      expect(weatherResultMsg?.content).toContain('北京');
      expect(weatherResultMsg?.content).toContain('22');

      // 验证第3轮 LLM 收到 writer sub-agent 结果（自定义 run 返回）
      const thirdRequest = completeRequests[2];
      const writerResultMsg = thirdRequest.messages.filter((m) => m.role === 'tool');
      const writerResult = writerResultMsg.find((m) => m.content.includes('草稿'));
      expect(writerResult?.content).toContain('AI');

      await app.close();
    });

    it('agent 参数注入到 handler，app.inject() 调用 /api/chat', async () => {
      await compileArtifacts();
      const app = await createProdApp({ rootDir: tempDir });

      // mock provider 响应序列（同上）
      const { provider } = createMockProvider([
        llmResponse({
          toolCalls: [{ id: 'c1', name: 'weather.getWeather', arguments: { city: '北京' } }],
        }),
        llmResponse({
          toolCalls: [{ id: 'c2', name: 'agent.writer', arguments: { topic: 'AI' } }],
        }),
        llmResponse({ content: 'inject 模式完成', stopReason: 'stop' }),
      ]);

      // 手动注册 agentHandleFactory（模拟 @faapi/agent 插件的 setup 行为）
      const deps = makeAgentDeps(provider);
      registerAgentHandleFactory(() => new Agent(deps));

      // 通过 app.inject() 调用 /api/chat
      const res = await app.inject({
        method: 'POST',
        path: '/api/chat',
        body: { input: '查询北京天气并撰写关于 AI 的报告' },
      });

      // 验证响应（handler return 被 config.response.ok 包裹为 { data }）
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        data: {
          content: 'inject 模式完成',
          turns: 3,
          stopReason: 'stop',
        },
      });

      await app.close();
    });

    it('tool input 校验失败时返回 { error }，不调 handler，回传 LLM 重试', async () => {
      await compileArtifacts();
      const app = await createProdApp({ rootDir: tempDir });

      // mock provider 响应序列：
      // 1. 调 weather.getWeather，参数不合法（缺少 city）→ validate 失败
      // 2. 收到 error 后返回最终答案
      const { provider, completeRequests } = createMockProvider([
        llmResponse({
          toolCalls: [{ id: 'c1', name: 'weather.getWeather', arguments: {} }],
        }),
        llmResponse({ content: '校验失败已处理', stopReason: 'stop' }),
      ]);

      const deps = makeAgentDeps(provider);
      const agent = new Agent(deps);
      const result = await agent.run('查询天气');

      // 验证最终结果（LLM 收到 error 后返回最终答案）
      expect(result.content).toBe('校验失败已处理');
      expect(result.turns).toBe(2);

      // 验证第2轮 LLM 收到 tool error 消息（validate 失败 → { error } 回传）
      const secondRequest = completeRequests[1];
      const toolResultMsg = secondRequest.messages.find((m) => m.role === 'tool');
      expect(toolResultMsg?.content).toContain('error');

      await app.close();
    });
  });

  describe('tool input 校验（zod.js 水合）', () => {
    it('weather tool 的 zod.js 生成且可被 resolveToolSchema 使用', async () => {
      await compileArtifacts();

      // 验证 weather tool 的 zod.js 存在
      const { existsSync } = await import('node:fs');
      const weatherZodPath = join(tempDir, 'dist', 'tools', 'weather', 'zod.js');
      expect(existsSync(weatherZodPath)).toBe(true);

      // 验证 zod.js 导出 WeatherInputSchema
      const mod = await import(weatherZodPath);
      expect(mod.WeatherInputSchema).toBeDefined();
      expect(typeof mod.WeatherInputSchema.safeParse).toBe('function');

      // 验证 schema 校验
      const valid = mod.WeatherInputSchema.safeParse({ city: '北京' });
      expect(valid.success).toBe(true);

      const invalid = mod.WeatherInputSchema.safeParse({});
      expect(invalid.success).toBe(false);
    });
  });
});
