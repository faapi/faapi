import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  evaluateAgentDeclaration,
  validateAgentDeclarations,
  loadAndEvaluateAgents,
} from './loadAgents';
import type { AgentMetadata } from './agentTypes';

/**
 * loadAgents 测试：agent 声明启动期求值与校验（声明运行时化装载管线）
 *
 * 覆盖：
 * - evaluateAgentDeclaration：run 迁移检测 / 缺 config / 函数求值 / 白名单 /
 *   互斥必填 / 逐字段类型校验（fail-fast，错误带 name + filePath 定位）
 * - validateAgentDeclarations：重名 / agents 引用存在性
 * - loadAndEvaluateAgents：真实模块 import → 求值 → 校验 → hydrate 往返
 */
describe('loadAgents', () => {
  // ─── evaluateAgentDeclaration ─────────────────────────────────────────

  describe('evaluateAgentDeclaration', () => {
    const locator = { name: 'researcher', filePath: 'dist/agents/researcher/handler.js' };

    it('合法 config 求值为 AgentMetadata（name/filePath 注入）', () => {
      const meta = evaluateAgentDeclaration(
        {
          config: {
            description: '研究员',
            systemPrompt: 'You are researcher',
            tools: ['search'],
            agents: ['writer'],
            maxTurns: 5,
            inputDescription: '研究主题',
            vars: { lang: 'zh' },
            reminders: ['先查资料'],
          },
        },
        locator,
      );

      expect(meta).toEqual({
        name: 'researcher',
        filePath: 'dist/agents/researcher/handler.js',
        description: '研究员',
        systemPrompt: 'You are researcher',
        tools: ['search'],
        agents: ['writer'],
        maxTurns: 5,
        inputDescription: '研究主题',
        vars: { lang: 'zh' },
        reminders: ['先查资料'],
      });
    });

    it('检测到 run 导出抛迁移错误', () => {
      expect(() =>
        evaluateAgentDeclaration({ config: { systemPrompt: 'x' }, run: async () => {} }, locator),
      ).toThrow(/run 导出.*声明式执行.*注册 tool/s);
    });

    it('缺少 config 导出抛错', () => {
      expect(() => evaluateAgentDeclaration({}, locator)).toThrow(/缺少 config 导出/);
    });

    it('config 为函数时调用求值（返回对象）', () => {
      const meta = evaluateAgentDeclaration(
        { config: () => ({ systemPrompt: 'from-factory' }) },
        locator,
      );
      expect(meta.systemPrompt).toBe('from-factory');
    });

    it('config 求值结果非对象抛错', () => {
      expect(() => evaluateAgentDeclaration({ config: 42 }, locator)).toThrow(
        /config 必须是对象或返回对象的函数.*got number/s,
      );
    });

    it('未知 config 字段抛错（静默忽略会掩盖拼写错误）', () => {
      expect(() =>
        evaluateAgentDeclaration({ config: { systemPrompt: 'x', systemPromt: 'typo' } }, locator),
      ).toThrow(/未知 config 字段 "systemPromt"/);
    });

    it('systemPrompt 与 systemPromptFile 互斥', () => {
      expect(() =>
        evaluateAgentDeclaration(
          { config: { systemPrompt: 'a', systemPromptFile: 'b.md' } },
          locator,
        ),
      ).toThrow(/互斥/);
    });

    it('systemPrompt 与 systemPromptFile 二选一必填', () => {
      expect(() => evaluateAgentDeclaration({ config: { description: 'x' } }, locator)).toThrow(
        /必须声明 systemPrompt/,
      );
    });

    it('systemPrompt 工厂函数形态合法', () => {
      const meta = evaluateAgentDeclaration({ config: { systemPrompt: () => 'dynamic' } }, locator);
      expect(typeof meta.systemPrompt).toBe('function');
    });

    it('locator 的 inputTypeName 静态事实透传（类型编译期擦除，config 求值拿不到）', () => {
      const meta = evaluateAgentDeclaration(
        { config: { systemPrompt: 'x' } },
        { ...locator, inputTypeName: 'Input' },
      );
      expect(meta.inputTypeName).toBe('Input');

      const without = evaluateAgentDeclaration({ config: { systemPrompt: 'x' } }, locator);
      expect(without.inputTypeName).toBeUndefined();
    });

    it('systemPrompt 非 string/函数抛错', () => {
      expect(() => evaluateAgentDeclaration({ config: { systemPrompt: 123 } }, locator)).toThrow(
        /systemPrompt 必须是 string 或工厂函数.*got number/s,
      );
    });

    it('maxTurns 非有限正数抛错', () => {
      expect(() =>
        evaluateAgentDeclaration({ config: { systemPrompt: 'x', maxTurns: 0 } }, locator),
      ).toThrow(/maxTurns 必须是有限正数/);
    });

    it('vars 嵌套对象抛错（平面对象约束）', () => {
      expect(() =>
        evaluateAgentDeclaration(
          { config: { systemPrompt: 'x', vars: { nested: { a: 1 } } } },
          locator,
        ),
      ).toThrow(/vars\.nested 必须是 string \| number \| boolean/);
    });

    it('reminders 三种合法形态（string/builder/对象）均通过', () => {
      const meta = evaluateAgentDeclaration(
        {
          config: {
            systemPrompt: 'x',
            reminders: ['静态串', () => '每轮', { when: 'everyTurn', content: '对象' }],
          },
        },
        locator,
      );
      expect(meta.reminders).toHaveLength(3);
    });

    it('reminders 非法形态抛错', () => {
      expect(() =>
        evaluateAgentDeclaration(
          { config: { systemPrompt: 'x', reminders: [{ nope: 1 }] } },
          locator,
        ),
      ).toThrow(/reminders\[0\] 必须是 string、函数或/);
    });

    it('tools 含非 string 元素抛错', () => {
      expect(() =>
        evaluateAgentDeclaration({ config: { systemPrompt: 'x', tools: [1] } }, locator),
      ).toThrow(/tools 必须是 string\[\]/);
    });

    it('错误信息带 agent 名与文件路径定位', () => {
      expect(() => evaluateAgentDeclaration({ config: 42 }, locator)).toThrow(
        /\[faapi\] agent "researcher" \(dist\/agents\/researcher\/handler\.js\)/,
      );
    });
  });

  // ─── validateAgentDeclarations ────────────────────────────────────────

  describe('validateAgentDeclarations', () => {
    function meta(name: string, agents?: string[]): AgentMetadata {
      return {
        name,
        filePath: `dist/agents/${name}/handler.js`,
        systemPrompt: 'x',
        ...(agents ? { agents } : {}),
      };
    }

    it('agent 名重复抛错（hydrate 语义后者覆盖，静默会丢 agent）', () => {
      expect(() => validateAgentDeclarations([meta('a'), meta('a')])).toThrow(/agent 名重复: "a"/);
    });

    it('agents 引用不存在的 agent 抛错（附可用清单）', () => {
      expect(() => validateAgentDeclarations([meta('a', ['missing'])])).toThrow(
        /agent "a" 的 agents 引用了不存在的 agent: "missing"（清单中可用: a）/,
      );
    });

    it('合法引用通过校验', () => {
      expect(() => validateAgentDeclarations([meta('a', ['b']), meta('b')])).not.toThrow();
    });
  });

  // ─── loadAndEvaluateAgents ────────────────────────────────────────────

  describe('loadAndEvaluateAgents', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = join(
        tmpdir(),
        `faapi-load-agents-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      mkdirSync(tempDir, { recursive: true });
    });

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    function createFakeRegistry() {
      const hydrated: AgentMetadata[] = [];
      return {
        hydrated,
        registries: {
          agent: {
            hydrate(agents: AgentMetadata[]): void {
              hydrated.push(...agents);
            },
          },
        },
      };
    }

    it('定位清单 → import → 求值 → 校验 → hydrate 全链路', async () => {
      const dir = join(tempDir, 'dist', 'agents', 'writer');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'handler.js'),
        "export const config = { systemPrompt: 'You are writer', tools: ['pen'] };",
      );

      const { hydrated, registries } = createFakeRegistry();
      const loaded = await loadAndEvaluateAgents(
        tempDir,
        'dist',
        [{ name: 'writer', filePath: 'dist/agents/writer/handler.js' }],
        registries,
      );

      expect(loaded).toHaveLength(1);
      expect(loaded[0]).toMatchObject({ name: 'writer', systemPrompt: 'You are writer' });
      expect(hydrated).toEqual(loaded);
    });

    it('函数形态 config 经真实 import 求值', async () => {
      const dir = join(tempDir, 'dist', 'agents', 'dynamic');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'handler.js'),
        'export const config = () => ({ systemPrompt: "from-module-factory" });',
      );

      const { registries } = createFakeRegistry();
      const loaded = await loadAndEvaluateAgents(
        tempDir,
        'dist',
        [{ name: 'dynamic', filePath: 'dist/agents/dynamic/handler.js' }],
        registries,
      );
      expect(loaded[0]!.systemPrompt).toBe('from-module-factory');
    });

    it('求值期违约抛错且注册表不 hydrate（fail-fast）', async () => {
      const dir = join(tempDir, 'dist', 'agents', 'bad');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'handler.js'),
        'export const config = { description: "缺少 systemPrompt" };',
      );

      const { hydrated, registries } = createFakeRegistry();
      await expect(
        loadAndEvaluateAgents(
          tempDir,
          'dist',
          [{ name: 'bad', filePath: 'dist/agents/bad/handler.js' }],
          registries,
        ),
      ).rejects.toThrow(/agent "bad".*必须声明 systemPrompt/s);
      expect(hydrated).toEqual([]);
    });

    it('handler 文件不存在时 import 错误原样浮出', async () => {
      const { registries } = createFakeRegistry();
      await expect(
        loadAndEvaluateAgents(
          tempDir,
          'dist',
          [{ name: 'ghost', filePath: 'dist/agents/ghost/handler.js' }],
          registries,
        ),
      ).rejects.toThrow();
    });
  });
});
