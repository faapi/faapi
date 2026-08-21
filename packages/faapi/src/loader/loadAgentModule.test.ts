import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadAgentModule, type AgentModule } from './loadAgentModule';

/**
 * loadAgentModule 测试：动态加载 agent handler 模块，提取 config 块和 run 函数
 *
 * 覆盖：
 * - 成功加载对象字面量 config（export const config = {...}）
 * - 成功加载函数形式 config（export function config() { return {...} }）
 * - 成功加载 run 函数（function / async / 箭头）
 * - config + run 同时导出
 * - 仅 config（无 run）
 * - 仅 run（无 config）
 * - 错误处理：加载不存在文件 / config 缺失 / config 非对象 / run 非函数
 * - dev 按需编译模式暂不测试（主流程在 compileOnDemand 测试覆盖）
 */
describe('loadAgentModule', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(
      tmpdir(),
      `faapi-load-agent-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** 写入 fixture 文件（返回绝对路径） */
  function writeFile(relPath: string, content: string): string {
    const abs = join(tempDir, ...relPath.split('/'));
    mkdirSync(join(tempDir, ...relPath.split('/').slice(0, -1)), { recursive: true });
    writeFileSync(abs, content);
    return abs;
  }

  describe('成功加载 config', () => {
    it('加载对象字面量 config（export const config = {...}）', async () => {
      const file = writeFile(
        'researcher.ts',
        `export const config = { systemPrompt: 'x', model: 'gpt-4' };\n`,
      );
      const result = await loadAgentModule(file, true, false);
      expect(result.config).toEqual({ systemPrompt: 'x', model: 'gpt-4' });
      expect(result.run).toBeUndefined();
    });

    it('加载函数形式 config（export function config() { return {...} }）', async () => {
      const file = writeFile(
        'researcher.ts',
        `export function config() { return { systemPrompt: 'dynamic', maxTurns: 5 }; }\n`,
      );
      const result = await loadAgentModule(file, true, false);
      expect(result.config).toEqual({ systemPrompt: 'dynamic', maxTurns: 5 });
      expect(result.run).toBeUndefined();
    });

    it('加载箭头函数 config（export const config = () => ({...}）', async () => {
      const file = writeFile(
        'researcher.ts',
        `export const config = () => ({ systemPrompt: 'arrow' });\n`,
      );
      const result = await loadAgentModule(file, true, false);
      expect(result.config).toEqual({ systemPrompt: 'arrow' });
    });

    it('config 函数形式可含动态字段（运行时求值，AST 阶段拿不到）', async () => {
      const file = writeFile(
        'researcher.ts',
        `const base = { model: 'gpt-4' };
export function config() { return { ...base, apiKey: 'dynamic-key' }; }\n`,
      );
      const result = await loadAgentModule(file, true, false);
      expect(result.config).toEqual({ model: 'gpt-4', apiKey: 'dynamic-key' });
    });

    it('hasConfig=false 时不提取 config（config 可不存在）', async () => {
      const file = writeFile('writer.ts', `export async function run(ctx) { return 'done'; }\n`);
      const result = await loadAgentModule(file, false, true);
      expect(result.config).toBeUndefined();
      expect(result.run).toBeDefined();
    });

    it('默认导出对象的 config 属性也能解析', async () => {
      const file = writeFile(
        'researcher.ts',
        `export default { config: { systemPrompt: 'default-export' } };\n`,
      );
      const result = await loadAgentModule(file, true, false);
      expect(result.config).toEqual({ systemPrompt: 'default-export' });
    });
  });

  describe('成功加载 run', () => {
    it('加载具名导出 function run', async () => {
      const file = writeFile('writer.ts', `export function run(ctx) { return 'done'; }\n`);
      const result = await loadAgentModule(file, false, true);
      expect(typeof result.run).toBe('function');
      expect(result.run!({})).toBe('done');
      expect(result.config).toBeUndefined();
    });

    it('加载具名导出 async function run', async () => {
      const file = writeFile(
        'writer.ts',
        `export async function run(ctx) { return 'async-done'; }\n`,
      );
      const result = await loadAgentModule(file, false, true);
      expect(typeof result.run).toBe('function');
      expect(await result.run!({})).toBe('async-done');
    });

    it('加载具名导出箭头函数 run', async () => {
      const file = writeFile('writer.ts', `export const run = (ctx) => 'arrow-done';\n`);
      const result = await loadAgentModule(file, false, true);
      expect(result.run!({})).toBe('arrow-done');
    });

    it('hasRun=false 时不提取 run', async () => {
      const file = writeFile(
        'researcher.ts',
        `export const config = { systemPrompt: 'x' };
export function run() { return 'should not be called'; }\n`,
      );
      const result = await loadAgentModule(file, true, false);
      expect(result.config).toBeDefined();
      expect(result.run).toBeUndefined();
    });

    it('默认导出对象的 run 属性也能解析', async () => {
      const file = writeFile(
        'writer.ts',
        `export default { run(ctx) { return 'default-run'; } };\n`,
      );
      const result = await loadAgentModule(file, false, true);
      expect(result.run!({})).toBe('default-run');
    });
  });

  describe('config + run 同时', () => {
    it('同时加载 config 块和 run 函数', async () => {
      const file = writeFile(
        'agent.ts',
        `export const config = { systemPrompt: 'prompt', model: 'gpt-4' };
export async function run(ctx) { return { output: 'ok' }; }\n`,
      );
      const result = await loadAgentModule(file, true, true);
      expect(result.config).toEqual({ systemPrompt: 'prompt', model: 'gpt-4' });
      expect(typeof result.run).toBe('function');
      expect(await result.run!({})).toEqual({ output: 'ok' });
    });

    it('AgentModule 类型包含 config 和 run', async () => {
      const file = writeFile(
        'agent.ts',
        `export const config = { x: 1 };
export function run() { return 'y'; }\n`,
      );
      const result: AgentModule = await loadAgentModule(file, true, true);
      expect(result).toHaveProperty('config');
      expect(result).toHaveProperty('run');
    });
  });

  describe('错误处理', () => {
    it('加载不存在的文件抛错（包含文件路径）', async () => {
      const file = join(tempDir, 'nonexistent.ts');
      await expect(loadAgentModule(file, true, false)).rejects.toThrow(
        /Failed to load agent module.*nonexistent\.ts/,
      );
    });

    it('hasConfig=true 但 config 导出缺失 → 抛错', async () => {
      const file = writeFile('no-config.ts', `export function run() { return 'ok'; }\n`);
      await expect(loadAgentModule(file, true, false)).rejects.toThrow(
        /no-config\.ts.*does not export "config"/,
      );
    });

    it('config 函数返回非对象 → 抛错', async () => {
      const file = writeFile('bad-config.ts', `export function config() { return 'string'; }\n`);
      await expect(loadAgentModule(file, true, false)).rejects.toThrow(
        /bad-config\.ts.*config\(\) did not return an object/,
      );
    });

    it('config 函数返回 null → 抛错', async () => {
      const file = writeFile('null-config.ts', `export function config() { return null; }\n`);
      await expect(loadAgentModule(file, true, false)).rejects.toThrow(
        /null-config\.ts.*config\(\) did not return an object/,
      );
    });

    it('config 既非对象也非函数 → 抛错', async () => {
      const file = writeFile('invalid-config.ts', `export const config = 'not an object';\n`);
      await expect(loadAgentModule(file, true, false)).rejects.toThrow(
        /invalid-config\.ts.*config export must be an object or function/,
      );
    });

    it('hasRun=true 但 run 不是函数 → 抛错', async () => {
      const file = writeFile('bad-run.ts', `export const run = 'not a function';\n`);
      await expect(loadAgentModule(file, false, true)).rejects.toThrow(
        /bad-run\.ts.*does not export a valid "run" function/,
      );
    });

    it('hasRun=true 但 run 导出缺失 → 抛错', async () => {
      const file = writeFile('no-run.ts', `export const config = { x: 1 };\n`);
      await expect(loadAgentModule(file, false, true)).rejects.toThrow(
        /no-run\.ts.*does not export a valid "run" function/,
      );
    });
  });

  describe('与 loadToolModule 行为对称', () => {
    it('空文件 + hasConfig=true 抛错（config 缺失）', async () => {
      const file = writeFile('empty.ts', `// intentionally empty\n`);
      await expect(loadAgentModule(file, true, false)).rejects.toThrow(
        /empty\.ts.*does not export "config"/,
      );
    });

    it('空文件 + hasConfig=false + hasRun=false → 返回 { config: undefined, run: undefined }', async () => {
      const file = writeFile('empty.ts', `// intentionally empty\n`);
      const result = await loadAgentModule(file, false, false);
      expect(result.config).toBeUndefined();
      expect(result.run).toBeUndefined();
    });

    it('同文件 config 和 run 都能独立加载（多次调用同一路径）', async () => {
      const file = writeFile(
        'multi.ts',
        `export const config = { systemPrompt: 'x' };
export function run() { return 'ok'; }\n`,
      );
      const r1 = await loadAgentModule(file, true, false);
      const r2 = await loadAgentModule(file, false, true);
      expect(r1.config).toEqual({ systemPrompt: 'x' });
      expect(r2.run!()).toBe('ok');
    });
  });
});
