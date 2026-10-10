/**
 * createAgentTestHarness e2e 测试——阴性对照 + 全链路
 *
 * 1. **阴性对照**：同一 fixtures 项目分别走 build 管线（compileArtifacts +
 *    createProdApp 水合）与 harness 扫描水合，断言注册表集合相等（agent 注册名 /
 *    tool 最终名 / 元数据字段 / resolveAgentTools / resolveSubAgents）——
 *    锁「harness 扫描结果与真实注册表对齐」。
 * 2. **全链路**：harness deps + createScriptLLM + Agent——真 reactLoop + 真工具 +
 *    假 LLM，覆盖工具结果回灌、sub-agent 派发（systemPrompt 传导）、generated
 *    模式入参校验失败回灌。
 *
 * 详见 faapi 的 agentTestHarness.md 与本包 scriptLlm.md。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, cpSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createProdApp, loadToolModule as loadToolModuleImpl, type AppBase } from '@faapi/faapi';
import { createAgentTestHarness, type AgentTestHarness } from '@faapi/faapi/testing';

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

import { Agent, type AgentDeps } from './agent';
import { createScriptLLM } from './scriptLlm';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.resolve(__dirname, '../fixtures/multi-agent-demo');

/** 编译 fixtures 产物（与 faapi build 一致）——供给 createProdApp 水合路线 */
async function compileArtifacts(root: string): Promise<void> {
  await compileDevRoutes({ rootDir: root, dist: 'dist' });
  await compileConfig({ rootDir: root, dist: 'dist' });

  const { routes, wsRoutes } = await scanRoutes(root, ['src/api/**/*.ts'], 'dist');
  const sorted = sortRoutes(routes);
  const serialized = serializeRoutes(sorted, wsRoutes, root, 'dist');
  await writeRoutesModule(serialized, join(root, 'dist', 'faapi-routes.js'));
  await generateSchemaFiles(sorted, root, 'dist');

  const agents = await scanAgents(root, ['src/agents/*/handler.ts']);
  await generateAgentArtifacts(agents, root, 'dist');

  const tools = await scanTools(root, ['src/tools/**/*.ts']);
  await generateToolArtifacts(tools, root, 'dist');
}

/** 从注册表视图快照 harness 可比的集合（剥产物目录前缀的 filePath 形态比较） */
function registrySnapshot(registries: {
  agent: {
    listAgents: () => { name: string }[];
    getAgent: (n: string) => Record<string, unknown> | undefined;
    getAgentEntry: (n: string) => { filePath: string; inputTypeName?: string } | undefined;
    resolveAgentTools: (n: string) => { name: string }[];
    resolveSubAgents: (n: string) => { name: string }[];
  };
  tool: { list: () => { name: string }[] };
}) {
  return {
    agentNames: registries.agent
      .listAgents()
      .map((a) => a.name)
      .sort(),
    toolNames: registries.tool
      .list()
      .map((t) => t.name)
      .sort(),
    // filePath 剔除后比较（产物目录前缀 dist vs 临时目录必然不同，形态由后缀断言覆盖）
    researcher: (() => {
      const { filePath: _filePath, ...core } = registries.agent.getAgent('researcher') ?? {};
      return core;
    })(),
    researcherEntryInputType: registries.agent.getAgentEntry('researcher')?.inputTypeName,
    researcherEntryFileSuffix: registries.agent
      .getAgentEntry('researcher')
      ?.filePath.replace(/\\/g, '/')
      .split('/')
      .slice(-3)
      .join('/'),
    researcherToolNames: registries.agent
      .resolveAgentTools('researcher')
      .map((t) => t.name)
      .sort(),
    researcherSubAgents: registries.agent.resolveSubAgents('researcher').map((a) => a.name),
  };
}

describe('createAgentTestHarness e2e', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(
      tmpdir(),
      `faapi-harness-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ─── 阴性对照：harness 扫描水合 vs build 管线 + createProdApp 水合 ────

  describe('阴性对照：与生产水合对齐', () => {
    it('agent/tool 集合与元数据同 createProdApp 水合结果相等', async () => {
      await compileArtifacts(tempDir);

      // 生产路线：build 产物 → createProdApp 水合（单 app 名额，断言后即关）
      const app: AppBase = await createProdApp({ rootDir: tempDir });
      const prodSnapshot = registrySnapshot(app.registries);
      await app.close();

      // harness 路线：同 rootDir 扫描水合（不建 app，无名额冲突）
      const h = await createAgentTestHarness({ rootDir: tempDir, schemaMode: 'generated' });
      const harnessSnapshot = registrySnapshot(h.registries);
      await h.close();

      expect(harnessSnapshot.agentNames).toEqual(prodSnapshot.agentNames);
      expect(harnessSnapshot.toolNames).toEqual(prodSnapshot.toolNames);
      // LLM 可见元数据逐字段相等（getAgent 返回对象整体比较）
      expect(harnessSnapshot.researcher).toEqual(prodSnapshot.researcher);
      expect(harnessSnapshot.researcherEntryInputType).toBe(prodSnapshot.researcherEntryInputType);
      // filePath 形态：两者均为产物形式（目录前缀不同——dist vs 临时目录），尾部路径一致
      expect(harnessSnapshot.researcherEntryFileSuffix).toBe(
        prodSnapshot.researcherEntryFileSuffix,
      );
      expect(harnessSnapshot.researcherEntryFileSuffix).toBe('agents/researcher/handler.js');
      expect(harnessSnapshot.researcherToolNames).toEqual(prodSnapshot.researcherToolNames);
      expect(harnessSnapshot.researcherSubAgents).toEqual(prodSnapshot.researcherSubAgents);
    });

    it('harness 与 createProdApp 不互斥：app 关闭后 harness 仍可创建（反之亦然）', async () => {
      // 先建 harness（不占 app 名额）
      const h = await createAgentTestHarness({ rootDir: tempDir });
      expect(h.agentNames.sort()).toEqual(['researcher', 'writer']);

      // 再建 app（build 产物路线）
      await compileArtifacts(tempDir);
      const app = await createProdApp({ rootDir: tempDir });
      expect(app.registries.agent.getAgent('writer')).toBeDefined();
      await app.close();

      await h.close();
      expect(existsSync(h.schemaDist)).toBe(false);
    });
  });

  // ─── 全链路：harness deps + createScriptLLM + Agent ─────────────────

  describe('全链路：真 reactLoop + 真工具 + 脚本假 LLM', () => {
    function makeDeps(h: AgentTestHarness): AgentDeps {
      return {
        providers: new Map(),
        llms: {},
        rootDir: tempDir,
        getAgent: h.registries.agent.getAgent,
        getAgentEntry: h.registries.agent.getAgentEntry,
        getTool: h.registries.tool.get,
        resolveAgentTools: h.registries.agent.resolveAgentTools,
        resolveSubAgents: h.registries.agent.resolveSubAgents,
        loadToolModule: h.loadToolModule,
        // generated 模式的 schema 解析（free-form 时为 undefined——不拼）
        ...(h.resolveToolSchema ? { resolveToolSchema: h.resolveToolSchema } : {}),
        ...(h.resolveAgentInputSchema
          ? { resolveAgentInputSchema: h.resolveAgentInputSchema }
          : {}),
      };
    }

    it('工具调用：handler 真实执行 + 结果按生产口径回灌 LLM', async () => {
      const h = await createAgentTestHarness({ rootDir: tempDir, schemaMode: 'generated' });
      const llm = createScriptLLM([
        { toolCalls: [{ name: 'weather_getWeather', arguments: { city: '北京' } }] },
        { content: '北京今天 22 度，晴。' },
      ]);
      const agent = new Agent(makeDeps(h));

      const result = await agent.run('北京天气怎么样？', { agent: 'researcher', provider: llm });

      expect(result.messages.at(-1)?.content).toBe('北京今天 22 度，晴。');
      // LLM 可见 tool 列表：显式声明的 tool + sub-agent 派发名
      const toolNames = llm.requests[0]!.tools?.map((t) => t.function.name) ?? [];
      expect(toolNames).toContain('weather_getWeather');
      expect(toolNames).toContain('calculator_calc');
      expect(toolNames).toContain('agent-writer');
      // 工具结果回灌：第 2 轮请求含 role='tool' 消息，内容为 handler 真实返回
      const toolMsg = llm.requests[1]!.messages.find((m) => m.role === 'tool');
      expect(String(toolMsg?.content)).toContain('"temperature":22');
      await h.close();
    });

    it('sub-agent 派发：writer systemPrompt 传导到子代理请求', async () => {
      const h = await createAgentTestHarness({ rootDir: tempDir, schemaMode: 'generated' });
      const llm = createScriptLLM([
        // 主控第 1 轮：派发 writer
        { toolCalls: [{ name: 'agent-writer', arguments: { input: '写一段天气总结' } }] },
        // writer 子代理响应（草稿作为 tool 结果回灌主控）
        { content: '天气总结草稿：今日晴。' },
        // 主控第 2 轮：收尾
        { content: '子代理草稿已收到。' },
      ]);
      const agent = new Agent(makeDeps(h));

      await agent.run('帮我写天气总结', { agent: 'researcher', provider: llm });

      // 第 2 轮请求是子代理（writer）的调用：system 消息携带 writer 人设
      const subRequest = llm.requests[1]!;
      const systemMsg = subRequest.messages.find((m) => m.role === 'system');
      expect(String(systemMsg?.content)).toContain('写作助手');
      // 交接单单字段 input 模式：user 消息即交接单原文
      const userMsg = subRequest.messages.find((m) => m.role === 'user');
      expect(String(userMsg?.content)).toContain('写一段天气总结');
      await h.close();
    });

    it('generated 模式：坏入参被 schema 校验拦截，以 { error } 回灌 LLM 重试', async () => {
      const h = await createAgentTestHarness({ rootDir: tempDir, schemaMode: 'generated' });
      const llm = createScriptLLM([
        // 坏入参：city 应为 string，脚本给 number
        { toolCalls: [{ name: 'weather_getWeather', arguments: { city: 123 } }] },
        // 修正后重试
        { toolCalls: [{ name: 'weather_getWeather', arguments: { city: '上海' } }] },
        { content: '上海 25 度。' },
      ]);
      const agent = new Agent(makeDeps(h));

      const result = await agent.run('上海天气', { agent: 'researcher', provider: llm });

      // 第 1 次调用被校验拦截：tool 消息是 error 形态且 handler 未执行（无温度数据）
      const firstToolMsg = llm.requests[1]!.messages.find((m) => m.role === 'tool');
      expect(String(firstToolMsg?.content)).toContain('error');
      // 第 2 次修正后 handler 真实执行——history 累积，第 3 轮请求含两条 tool 消息
      // （[0]=error 回灌、[1]=成功结果），取第二条
      const toolMsgs = llm.requests[2]!.messages.filter((m) => m.role === 'tool');
      expect(toolMsgs).toHaveLength(2);
      const secondToolMsg = toolMsgs[1];
      expect(String(secondToolMsg?.content)).toContain('"temperature":25');
      expect(result.messages.at(-1)?.content).toBe('上海 25 度。');
      await h.close();
    });

    it('loadToolModule 桥接与生产 loader 等价（产物形式 filePath 直装）', async () => {
      const h = await createAgentTestHarness({ rootDir: tempDir });
      const meta = h.registries.tool.get('calculator_calc')!;
      const mod = await h.loadToolModule(meta.filePath, meta.functionName);
      const result = (await mod.handler({ expression: '6*7' })) as { result: number };
      expect(result.result).toBe(42);
      // 桥接内部已转绝对路径——与主包 loadToolModule 直接调用等价
      const direct = await loadToolModuleImpl(
        path.isAbsolute(meta.filePath) ? meta.filePath : path.resolve(tempDir, meta.filePath),
        meta.functionName,
        tempDir,
      );
      expect(await direct.handler({ expression: '1+1' })).toEqual({
        expression: '1+1',
        result: 2,
      });
      await h.close();
    });
  });
});
