import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  serializeAgents,
  writeAgentsModule,
  hydrateAgents,
  generateAgentArtifacts,
  type SerializedAgentRecord,
} from './generateAgentArtifacts';
import { importWithCacheBust } from '../utils/importWithCacheBust';
import type { AgentManifest } from '../agents/agentTypes';
import type { AgentMetadata } from '../ast/extractAgentMetadata';
import { invalidateProgramCache } from '../ast/createProgram';

/**
 * generateAgentArtifacts 测试：从 AgentManifest[] 生成 faapi-agents.js
 *
 * 覆盖：
 * - serializeAgents：序列化 AgentMetadata → SerializedAgentRecord（filePath 转产物形式）
 * - hydrateAgents：水合 SerializedAgentRecord → AgentMetadata
 * - writeAgentsModule：写入 faapi-agents.js
 * - generateAgentArtifacts：端到端主入口（AST 增强 + 序列化 + 写入）
 *
 * agent 不生成 zod.js（与 tool 的关键差异），仅生成清单产物。
 */
describe('generateAgentArtifacts', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(
      tmpdir(),
      `faapi-gen-agent-artifacts-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    invalidateProgramCache();
  });

  // ─── serializeAgents ──────────────────────────────────────────────────

  describe('serializeAgents', () => {
    it('完整字段 agent filePath 转产物形式(src/agents/... → dist/agents/...)', () => {
      const meta: AgentMetadata = {
        name: 'researcher',
        description: '研究助手',
        filePath: 'src/agents/researcher/handler.ts',
        hasRun: false,
        systemPrompt: 'You are a researcher',
        tools: ['web-search.search'],
        agents: ['writer'],
        model: 'gpt-4',
        maxTurns: 10,
      };
      const result = serializeAgents([meta], 'dist');
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        name: 'researcher',
        description: '研究助手',
        hasRun: false,
        systemPrompt: 'You are a researcher',
        tools: ['web-search.search'],
        agents: ['writer'],
        model: 'gpt-4',
        maxTurns: 10,
        filePath: 'dist/agents/researcher/handler.js',
      });
    });

    it('仅必填字段 agent 省略 undefined 字段', () => {
      const meta: AgentMetadata = {
        name: 'researcher',
        filePath: 'src/agents/researcher/handler.ts',
        hasRun: true,
        // description / systemPrompt / tools / agents / model / maxTurns 均为 undefined
      };
      const result = serializeAgents([meta], 'dist');
      expect(result[0].name).toBe('researcher');
      expect(result[0].hasRun).toBe(true);
      expect(result[0].filePath).toBe('dist/agents/researcher/handler.js');
      expect(result[0].description).toBeUndefined();
      expect(result[0].systemPrompt).toBeUndefined();
      expect(result[0].tools).toBeUndefined();
      expect(result[0].agents).toBeUndefined();
      expect(result[0].model).toBeUndefined();
      expect(result[0].maxTurns).toBeUndefined();
    });

    it('dev 模式 dist 为 .faapi', () => {
      const meta: AgentMetadata = {
        name: 'researcher',
        filePath: 'src/agents/researcher/handler.ts',
        hasRun: false,
      };
      const result = serializeAgents([meta], '.faapi');
      expect(result[0].filePath).toBe('.faapi/agents/researcher/handler.js');
    });

    it('dist 默认为 dist', () => {
      const meta: AgentMetadata = {
        name: 'researcher',
        filePath: 'src/agents/researcher/handler.ts',
        hasRun: false,
      };
      const result = serializeAgents([meta]);
      expect(result[0].filePath).toBe('dist/agents/researcher/handler.js');
    });

    it('多个 agent 同时序列化', () => {
      const metas: AgentMetadata[] = [
        {
          name: 'researcher',
          description: '研究助手',
          filePath: 'src/agents/researcher/handler.ts',
          hasRun: false,
          model: 'gpt-4',
        },
        {
          name: 'writer',
          description: '写作助手',
          filePath: 'src/agents/writer/handler.ts',
          hasRun: true,
          maxTurns: 5,
        },
      ];
      const result = serializeAgents(metas, 'dist');
      expect(result).toHaveLength(2);
      expect(result.map((r) => r.name)).toEqual(['researcher', 'writer']);
      expect(result[0].filePath).toBe('dist/agents/researcher/handler.js');
      expect(result[1].filePath).toBe('dist/agents/writer/handler.js');
    });
  });

  // ─── hydrateAgents ───────────────────────────────────────────────────

  describe('hydrateAgents', () => {
    it('字段一一对应还原', () => {
      const serialized: SerializedAgentRecord[] = [
        {
          name: 'researcher',
          description: '研究助手',
          hasRun: false,
          systemPrompt: 'You are a researcher',
          tools: ['web-search.search'],
          agents: ['writer'],
          model: 'gpt-4',
          maxTurns: 10,
          filePath: 'dist/agents/researcher/handler.js',
        },
      ];
      const hydrated = hydrateAgents(serialized);
      expect(hydrated).toHaveLength(1);
      expect(hydrated[0]).toEqual({
        name: 'researcher',
        description: '研究助手',
        filePath: 'dist/agents/researcher/handler.js',
        hasRun: false,
        systemPrompt: 'You are a researcher',
        tools: ['web-search.search'],
        agents: ['writer'],
        model: 'gpt-4',
        maxTurns: 10,
      });
    });

    it('undefined 字段正确还原(缺失字段兜底为 undefined)', () => {
      // 模拟从 JSON.parse 还原后的对象(undefined 字段在 JSON 中被省略)
      const serialized = [
        {
          name: 'researcher',
          hasRun: true,
          filePath: 'dist/agents/researcher/handler.js',
          // description / systemPrompt / tools / agents / model / maxTurns 缺失
        },
      ] as unknown as SerializedAgentRecord[];
      const hydrated = hydrateAgents(serialized);
      expect(hydrated[0].name).toBe('researcher');
      expect(hydrated[0].hasRun).toBe(true);
      expect(hydrated[0].description).toBeUndefined();
      expect(hydrated[0].systemPrompt).toBeUndefined();
      expect(hydrated[0].tools).toBeUndefined();
      expect(hydrated[0].agents).toBeUndefined();
      expect(hydrated[0].model).toBeUndefined();
      expect(hydrated[0].maxTurns).toBeUndefined();
    });

    it('serializeAgents + hydrateAgents 往返一致(filePath 保持产物形式)', () => {
      const original: AgentMetadata[] = [
        {
          name: 'researcher',
          description: '研究助手',
          filePath: 'src/agents/researcher/handler.ts',
          hasRun: false,
          systemPrompt: 'prompt',
          model: 'gpt-4',
        },
        {
          name: 'writer',
          filePath: 'src/agents/writer/handler.ts',
          hasRun: true,
        },
      ];
      const serialized = serializeAgents(original, 'dist');
      const hydrated = hydrateAgents(serialized);
      // filePath 已转为产物形式,其他字段一致
      expect(hydrated[0].filePath).toBe('dist/agents/researcher/handler.js');
      expect(hydrated[0].name).toBe(original[0].name);
      expect(hydrated[0].description).toBe(original[0].description);
      expect(hydrated[0].systemPrompt).toBe(original[0].systemPrompt);
      expect(hydrated[0].model).toBe(original[0].model);
      expect(hydrated[1].filePath).toBe('dist/agents/writer/handler.js');
      expect(hydrated[1].description).toBeUndefined();
    });
  });

  // ─── writeAgentsModule ───────────────────────────────────────────────

  describe('writeAgentsModule', () => {
    it('写入 faapi-agents.js,内容含 export const agents', async () => {
      const outputPath = join(tempDir, 'faapi-agents.js');
      const manifest: SerializedAgentRecord[] = [
        {
          name: 'researcher',
          description: '研究助手',
          hasRun: false,
          systemPrompt: 'You are a researcher',
          model: 'gpt-4',
          maxTurns: 10,
          filePath: 'dist/agents/researcher/handler.js',
        },
      ];
      await writeAgentsModule(manifest, outputPath);
      expect(existsSync(outputPath)).toBe(true);

      const content = readFileSync(outputPath, 'utf-8');
      expect(content).toContain('export const agents =');
      expect(content).toContain('researcher');
      expect(content).toContain('研究助手');
      expect(content).toContain('You are a researcher');
      expect(content).toContain('gpt-4');
      expect(content).toContain('dist/agents/researcher/handler.js');
    });

    it('空清单也写入(空数组)', async () => {
      const outputPath = join(tempDir, 'faapi-agents.js');
      await writeAgentsModule([], outputPath);
      expect(existsSync(outputPath)).toBe(true);
      const content = readFileSync(outputPath, 'utf-8');
      expect(content).toContain('export const agents = []');
    });

    it('自动创建目录', async () => {
      const outputPath = join(tempDir, 'nested', 'dir', 'faapi-agents.js');
      await writeAgentsModule([], outputPath);
      expect(existsSync(outputPath)).toBe(true);
    });
  });

  // ─── generateAgentArtifacts(端到端主入口) ──────────────────────────────

  describe('generateAgentArtifacts', () => {
    /** 创建 agent fixture 文件 */
    function writeAgent(relPath: string, content: string): string {
      const absPath = join(tempDir, ...relPath.split('/'));
      mkdirSync(join(tempDir, ...relPath.split('/').slice(0, -1)), { recursive: true });
      writeFileSync(absPath, content);
      return relPath;
    }

    it('从 AgentManifest[] 生成 faapi-agents.js(含 config 块字段)', async () => {
      writeAgent(
        'src/agents/researcher/handler.ts',
        `/**
 * 研究助手
 * @agent researcher
 */
export const config = {
  systemPrompt: 'You are a researcher',
  tools: ['web-search.search'],
  agents: ['writer'],
  model: 'gpt-4',
  maxTurns: 10,
};
`,
      );

      const agents: AgentManifest[] = [
        {
          name: 'researcher',
          filePath: 'src/agents/researcher/handler.ts',
          hasRun: false,
        },
      ];
      const dist = join(tempDir, 'dist');
      const metadata = await generateAgentArtifacts(agents, tempDir, dist);

      // 返回值是 AST 增强后的 AgentMetadata
      expect(metadata).toHaveLength(1);
      expect(metadata[0].name).toBe('researcher');
      expect(metadata[0].description).toBe('研究助手');
      expect(metadata[0].hasRun).toBe(false);
      expect(metadata[0].systemPrompt).toBe('You are a researcher');
      expect(metadata[0].tools).toEqual(['web-search.search']);
      expect(metadata[0].agents).toEqual(['writer']);
      expect(metadata[0].model).toBe('gpt-4');
      expect(metadata[0].maxTurns).toBe(10);

      // faapi-agents.js 生成
      const agentsPath = join(dist, 'faapi-agents.js');
      expect(existsSync(agentsPath)).toBe(true);
      const content = readFileSync(agentsPath, 'utf-8');
      expect(content).toContain('export const agents =');
      expect(content).toContain('researcher');
      expect(content).toContain('研究助手');
      expect(content).toContain('You are a researcher');
      expect(content).toContain('web-search.search');
      expect(content).toContain('gpt-4');
      expect(content).toContain('dist/agents/researcher/handler.js');
    });

    it('仅 hasRun 的 agent(无 config 块)从 run 提取 JSDoc', async () => {
      writeAgent(
        'src/agents/writer/handler.ts',
        `/**
 * 写作助手
 */
export async function run(ctx) { return 'done'; }
`,
      );

      const agents: AgentManifest[] = [
        {
          name: 'writer',
          filePath: 'src/agents/writer/handler.ts',
          hasRun: true,
        },
      ];
      const dist = join(tempDir, 'dist');
      const metadata = await generateAgentArtifacts(agents, tempDir, dist);

      expect(metadata[0].name).toBe('writer');
      expect(metadata[0].description).toBe('写作助手');
      expect(metadata[0].hasRun).toBe(true);
      // 无 config 块,systemPrompt 等字段为 undefined
      expect(metadata[0].systemPrompt).toBeUndefined();
      expect(metadata[0].model).toBeUndefined();
    });

    it('不生成 zod.js(与 tool 的关键差异)', async () => {
      writeAgent(
        'src/agents/researcher/handler.ts',
        `export const config = { systemPrompt: 'x' };
`,
      );

      const agents: AgentManifest[] = [
        {
          name: 'researcher',
          filePath: 'src/agents/researcher/handler.ts',
          hasRun: false,
        },
      ];
      const dist = join(tempDir, 'dist');
      await generateAgentArtifacts(agents, tempDir, dist);

      // faapi-agents.js 生成
      expect(existsSync(join(dist, 'faapi-agents.js'))).toBe(true);
      // 不生成 zod.js(agent 无输入参数,无需 schema)
      expect(existsSync(join(dist, 'agents', 'researcher', 'zod.js'))).toBe(false);
    });

    it('空清单不报错(faapi-agents.js 为空数组)', async () => {
      const dist = join(tempDir, 'dist');
      const metadata = await generateAgentArtifacts([], tempDir, dist);
      expect(metadata).toEqual([]);
      expect(existsSync(join(dist, 'faapi-agents.js'))).toBe(true);
      const content = readFileSync(join(dist, 'faapi-agents.js'), 'utf-8');
      expect(content).toContain('export const agents = []');
    });

    it('faapi-agents.js 可被 import 还原为 AgentMetadata[]', async () => {
      writeAgent(
        'src/agents/researcher/handler.ts',
        `/** 研究助手 */
export const config = { systemPrompt: 'prompt', model: 'gpt-4' };
`,
      );

      const agents: AgentManifest[] = [
        {
          name: 'researcher',
          filePath: 'src/agents/researcher/handler.ts',
          hasRun: false,
        },
      ];
      // dist 用相对路径(避免 toProdFilePath 拼出绝对路径)
      const dist = 'dist';
      await generateAgentArtifacts(agents, tempDir, dist);

      // import faapi-agents.js
      const agentsPath = join(tempDir, dist, 'faapi-agents.js');
      const mod = (await importWithCacheBust(agentsPath)) as {
        agents: SerializedAgentRecord[];
      };
      expect(mod.agents).toHaveLength(1);
      expect(mod.agents[0].name).toBe('researcher');
      expect(mod.agents[0].description).toBe('研究助手');
      expect(mod.agents[0].systemPrompt).toBe('prompt');
      expect(mod.agents[0].model).toBe('gpt-4');
      expect(mod.agents[0].filePath).toBe('dist/agents/researcher/handler.js');

      // 用 hydrateAgents 还原
      const hydrated = hydrateAgents(mod.agents);
      expect(hydrated).toHaveLength(1);
      expect(hydrated[0].name).toBe('researcher');
      expect(hydrated[0].description).toBe('研究助手');
      expect(hydrated[0].systemPrompt).toBe('prompt');
    });

    it('多个 agent 混合生成(config + run 各一)', async () => {
      writeAgent(
        'src/agents/researcher/handler.ts',
        `/** 研究助手 */
export const config = { systemPrompt: 'x', model: 'gpt-4' };
`,
      );
      writeAgent(
        'src/agents/writer/handler.ts',
        `/** 写作助手 */
export async function run(ctx) { return 'done'; }
`,
      );

      const agents: AgentManifest[] = [
        {
          name: 'researcher',
          filePath: 'src/agents/researcher/handler.ts',
          hasRun: false,
        },
        {
          name: 'writer',
          filePath: 'src/agents/writer/handler.ts',
          hasRun: true,
        },
      ];
      const dist = join(tempDir, 'dist');
      const metadata = await generateAgentArtifacts(agents, tempDir, dist);

      // faapi-agents.js 含两个 agent
      const content = readFileSync(join(dist, 'faapi-agents.js'), 'utf-8');
      expect(content).toContain('researcher');
      expect(content).toContain('writer');
      expect(content).toContain('研究助手');
      expect(content).toContain('写作助手');

      // metadata 各自字段正确
      expect(metadata).toHaveLength(2);
      expect(metadata[0].name).toBe('researcher');
      expect(metadata[0].model).toBe('gpt-4');
      expect(metadata[1].name).toBe('writer');
      expect(metadata[1].hasRun).toBe(true);
      expect(metadata[1].model).toBeUndefined();
    });

    it('dev 模式 dist 为 .faapi', async () => {
      writeAgent(
        'src/agents/researcher/handler.ts',
        `export const config = { systemPrompt: 'x' };
`,
      );

      const agents: AgentManifest[] = [
        {
          name: 'researcher',
          filePath: 'src/agents/researcher/handler.ts',
          hasRun: false,
        },
      ];
      const dist = join(tempDir, '.faapi');
      await generateAgentArtifacts(agents, tempDir, dist);

      expect(existsSync(join(dist, 'faapi-agents.js'))).toBe(true);
      const content = readFileSync(join(dist, 'faapi-agents.js'), 'utf-8');
      expect(content).toContain('.faapi/agents/researcher/handler.js');
    });

    it('@agent JSDoc 覆盖目录推导名', async () => {
      writeAgent(
        'src/agents/researcher/handler.ts',
        `/**
 * 研究助手
 * @agent custom-researcher
 */
export const config = { systemPrompt: 'x' };
`,
      );

      const agents: AgentManifest[] = [
        {
          name: 'researcher', // 目录推导名
          filePath: 'src/agents/researcher/handler.ts',
          hasRun: false,
        },
      ];
      const dist = join(tempDir, 'dist');
      const metadata = await generateAgentArtifacts(agents, tempDir, dist);

      // @agent 覆盖目录推导名
      expect(metadata[0].name).toBe('custom-researcher');
      expect(metadata[0].description).toBe('研究助手');

      const content = readFileSync(join(dist, 'faapi-agents.js'), 'utf-8');
      expect(content).toContain('custom-researcher');
    });
  });
});
