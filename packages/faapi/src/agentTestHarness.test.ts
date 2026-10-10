/**
 * createAgentTestHarness 单元测试——agent 流程测试设施的行为定义
 *
 * fixture 项目在临时目录搭建（ agents + tools + src 内依赖闭包），
 * 覆盖：free-form/generated 两模式、扫描水合与生产管线一致（覆盖名/嵌套命名）、
 * loadToolModule 真实装载（含 src 内依赖闭包编译）、close 幂等清理、
 * 构建期错误冒泡。
 *
 * 详见 [agentTestHarness.md](./agentTestHarness.md)。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAgentTestHarness, type AgentTestHarness } from './agentTestHarness';
import type { ToolMetadata } from './ast/extractToolMetadata';

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

  // tool 的 src 内依赖（闭包编译用例：handler import 项目模块）
  w('src/lib/rate.ts', 'export const rate = 3;\n');

  // agent：声明 Input（派发入参富 schema）+ tools/agents 引用
  w(
    'src/agents/researcher/handler.ts',
    `export interface Input {
  /** 研究主题 */
  topic: string;
}

/** 研究助手 */
export const config = {
  systemPrompt: '你是研究助手',
  tools: ['weather_getWeather', 'calc_calc'],
  agents: ['group_nested'],
  model: 'gpt-4o',
  maxTurns: 5,
};
`,
  );

  // agent：@agent 覆盖名 + systemPromptFile 声明
  w(
    'src/agents/overridden/handler.ts',
    `/**
 * 覆盖名用例
 * @agent fancy-name
 */
export const config = {
  systemPromptFile: 'prompts/overridden.md',
};
`,
  );

  // agent：嵌套目录（目录推导名 group_nested）
  w(
    'src/agents/group/nested/handler.ts',
    `export const config = {
  systemPrompt: '嵌套 agent',
};
`,
  );

  // tool：入参 interface（generated 模式生成 zod schema）
  w(
    'src/tools/weather/handler.ts',
    `export interface WeatherInput {
  /** 城市名 */
  city: string;
}

export async function getWeather(input: WeatherInput) {
  const temps: Record<string, number> = { 北京: 22 };
  return { city: input.city, temperature: temps[input.city] ?? 20 };
}
`,
  );

  // tool：@tool 覆盖名
  w(
    'src/tools/override/handler.ts',
    `/**
 * 当前时间
 * @tool override_now
 */
export function getNow() {
  return { now: 'fixed' };
}
`,
  );

  // tool：import src 内项目模块（闭包编译）——calc 位于 src/tools/calc/，
  // 上一级是 src/tools/，故 src/lib 需两级 ../
  w(
    'src/tools/calc/handler.ts',
    `import { rate } from '../../lib/rate';

export interface CalcInput {
  base: number;
}

export function calc(input: CalcInput) {
  return { total: input.base * rate };
}
`,
  );
}

async function makeHarness(
  root: string,
  options?: { schemaMode?: 'free-form' | 'generated' },
): Promise<AgentTestHarness> {
  return createAgentTestHarness({ rootDir: root, ...options });
}

describe('createAgentTestHarness', () => {
  let projectRoot: string;

  beforeAll(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'faapi-harness-unit-'));
    writeProject(projectRoot);
  });

  afterAll(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  // ─── free-form（默认） ──────────────────────────────────────────

  describe('free-form（默认）', () => {
    let h: AgentTestHarness;

    beforeAll(async () => {
      h = await makeHarness(projectRoot);
    });

    afterAll(async () => {
      await h.close();
    });

    it('agentNames 含 @agent 覆盖名与嵌套目录推导名', () => {
      expect(h.agentNames.sort()).toEqual(['fancy-name', 'group_nested', 'researcher']);
    });

    it('toolNames 含 @tool 覆盖名与命名空间推导名', () => {
      expect(h.toolNames.sort()).toEqual(['calc_calc', 'override_now', 'weather_getWeather']);
    });

    it('registries.agent 查询与生产同接口：getAgent 字段完整', () => {
      const core = h.registries.agent.getAgent('researcher');
      expect(core).toBeDefined();
      expect(core!.name).toBe('researcher');
      expect(core!.systemPrompt).toBe('你是研究助手');
      expect(core!.tools).toEqual(['weather_getWeather', 'calc_calc']);
      expect(core!.agents).toEqual(['group_nested']);
      expect(core!.model).toBe('gpt-4o');
      expect(core!.maxTurns).toBe(5);
    });

    it('systemPromptFile 声明提取（覆盖名 agent）', () => {
      const core = h.registries.agent.getAgent('fancy-name');
      expect(core).toBeDefined();
      expect(core!.systemPromptFile).toBe('prompts/overridden.md');
      expect(core!.systemPrompt).toBeUndefined();
    });

    it('getAgentEntry 含 inputTypeName 与产物形式 filePath', () => {
      const entry = h.registries.agent.getAgentEntry('researcher');
      expect(entry).toBeDefined();
      expect(entry!.inputTypeName).toBe('Input');
      expect(entry!.filePath).toMatch(/agents\/researcher\/handler\.js$/);
    });

    it('resolveAgentTools / resolveSubAgents / asTool 全量可用', () => {
      const tools = h.registries.agent.resolveAgentTools('researcher');
      expect(tools.map((t) => t.name).sort()).toEqual(['calc_calc', 'weather_getWeather']);

      const subs = h.registries.agent.resolveSubAgents('researcher');
      expect(subs.map((a) => a.name)).toEqual(['group_nested']);

      const asTool = h.registries.agent.asTool('researcher');
      expect(asTool).toBeDefined();
      expect(asTool!.name).toBe('agent-researcher');
      expect(asTool!.agentName).toBe('researcher');
    });

    it('loadToolModule 真实装载 handler 并可调用', async () => {
      const meta = h.registries.tool.get('weather_getWeather')!;
      expect(meta).toBeDefined();
      const mod = await h.loadToolModule(meta.filePath, meta.functionName);
      const result = (await mod.handler({ city: '北京' })) as { temperature: number };
      expect(result.temperature).toBe(22);
    });

    it('src 内依赖闭包随装载编译（handler import 项目模块）', async () => {
      const meta = h.registries.tool.get('calc_calc')!;
      const mod = await h.loadToolModule(meta.filePath, meta.functionName);
      const result = mod.handler({ base: 5 }) as { total: number };
      expect(result.total).toBe(15);
    });

    it('free-form 放行：不提供 schema 解析器', () => {
      expect(h.resolveToolSchema).toBeUndefined();
      expect(h.resolveAgentInputSchema).toBeUndefined();
    });

    it('free-form 不生成 zod.js（tool 与 agent 均不生成）', () => {
      expect(existsSync(join(h.schemaDist, 'tools', 'weather', 'zod.js'))).toBe(false);
      expect(existsSync(join(h.schemaDist, 'agents', 'researcher', 'zod.js'))).toBe(false);
    });
  });

  // ─── generated ─────────────────────────────────────────────────

  describe('generated', () => {
    let h: AgentTestHarness;

    beforeAll(async () => {
      h = await makeHarness(projectRoot, { schemaMode: 'generated' });
    });

    afterAll(async () => {
      await h?.close();
    });

    it('zod.js 现场生成（tool 与声明 Input 的 agent）', () => {
      expect(existsSync(join(h.schemaDist, 'tools', 'weather', 'zod.js'))).toBe(true);
      expect(existsSync(join(h.schemaDist, 'agents', 'researcher', 'zod.js'))).toBe(true);
    });

    it('resolveToolSchema 生产口径：JSON Schema + 校验函数', async () => {
      const meta = h.registries.tool.get('weather_getWeather') as ToolMetadata;
      const resolution = await h.resolveToolSchema!(meta);
      expect(resolution).toBeDefined();
      expect(JSON.stringify(resolution!.jsonSchema)).toContain('city');

      const good = resolution!.validate({ city: '北京' });
      expect(good).toEqual({ ok: true, value: { city: '北京' } });

      const bad = resolution!.validate({ city: 123 });
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.error).toBeTruthy();
    });

    it('resolveAgentInputSchema 同一实例：派发入参 schema 可解析', async () => {
      const entry = h.registries.agent.getAgentEntry('researcher')!;
      const resolution = await h.resolveAgentInputSchema!(entry);
      expect(resolution).toBeDefined();
      expect(JSON.stringify(resolution!.jsonSchema)).toContain('topic');

      expect(resolution!.validate({ topic: 'faapi' })).toEqual({
        ok: true,
        value: { topic: 'faapi' },
      });
      expect(resolution!.validate({}).ok).toBe(false);
    });

    it('未声明 Input 的 agent 解析为 undefined（单字段 input 模式）', async () => {
      const entry = h.registries.agent.getAgentEntry('group_nested')!;
      expect(entry.inputTypeName).toBeUndefined();
      const resolution = await h.resolveAgentInputSchema!(entry);
      expect(resolution).toBeUndefined();
    });
  });

  // ─── close ─────────────────────────────────────────────────────

  describe('close', () => {
    it('清理产物目录且幂等', async () => {
      const h = await makeHarness(projectRoot);
      expect(existsSync(h.schemaDist)).toBe(true);

      await h.close();
      expect(existsSync(h.schemaDist)).toBe(false);

      await expect(h.close()).resolves.toBeUndefined();
    });
  });

  // ─── 错误路径 ──────────────────────────────────────────────────

  it('rootDir 不存在显式抛错', async () => {
    await expect(
      createAgentTestHarness({ rootDir: join(projectRoot, 'no-such-dir') }),
    ).rejects.toThrow(/rootDir/);
  });

  it('agent 构建期校验错误冒泡（缺 systemPrompt/systemPromptFile）', async () => {
    const bad = mkdtempSync(join(tmpdir(), 'faapi-harness-bad-'));
    try {
      mkdirSync(join(bad, 'src', 'agents', 'empty'), { recursive: true });
      writeFileSync(
        join(bad, 'src', 'agents', 'empty', 'handler.ts'),
        'export const config = { tools: [] };\n',
      );
      await expect(makeHarness(bad)).rejects.toThrow();
    } finally {
      rmSync(bad, { recursive: true, force: true });
    }
  });

  it('从 @faapi/faapi/testing 入口可导入（公开契约锁定）', async () => {
    const testing = await import('./testing');
    expect(typeof testing.createAgentTestHarness).toBe('function');
  });
});
