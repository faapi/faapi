import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadAgentModule } from './loadAgentModule';

/**
 * loadAgentModule 测试：动态加载 agent handler 模块，提取 run 函数
 *
 * 覆盖：
 * - 成功加载 run 函数（function / async / 箭头）
 * - 错误处理：加载不存在文件 / run 非函数
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

  describe('成功加载 run', () => {
    it('加载具名导出 function run', async () => {
      const file = writeFile('writer.ts', `export function run(ctx) { return 'done'; }\n`);
      const result = await loadAgentModule(file, true);
      expect(typeof result.run).toBe('function');
      expect(result.run!({})).toBe('done');
    });

    it('加载具名导出 async function run', async () => {
      const file = writeFile(
        'writer.ts',
        `export async function run(ctx) { return 'async-done'; }\n`,
      );
      const result = await loadAgentModule(file, true);
      expect(typeof result.run).toBe('function');
      expect(await result.run!({})).toBe('async-done');
    });

    it('加载具名导出箭头函数 run', async () => {
      const file = writeFile('writer.ts', `export const run = (ctx) => 'arrow-done';\n`);
      const result = await loadAgentModule(file, true);
      expect(result.run!({})).toBe('arrow-done');
    });

    it('hasRun=false 时不提取 run', async () => {
      const file = writeFile(
        'researcher.ts',
        `export const config = { systemPrompt: 'x' };
export function run() { return 'should not be called'; }\n`,
      );
      const result = await loadAgentModule(file, false);
      expect(result.run).toBeUndefined();
    });

    it('默认导出对象的 run 属性也能解析', async () => {
      const file = writeFile(
        'writer.ts',
        `export default { run(ctx) { return 'default-run'; } };\n`,
      );
      const result = await loadAgentModule(file, true);
      expect(result.run!({})).toBe('default-run');
    });
  });

  describe('错误处理', () => {
    it('加载不存在的文件抛错（包含文件路径）', async () => {
      const file = join(tempDir, 'nonexistent.ts');
      await expect(loadAgentModule(file, false)).rejects.toThrow(
        /Failed to load agent module.*nonexistent\.ts/,
      );
    });

    it('hasRun=true 但 run 不是函数 → 抛错', async () => {
      const file = writeFile('bad-run.ts', `export const run = 'not a function';\n`);
      await expect(loadAgentModule(file, true)).rejects.toThrow(
        /bad-run\.ts.*does not export a valid "run" function/,
      );
    });

    it('hasRun=true 但 run 导出缺失 → 抛错', async () => {
      const file = writeFile('no-run.ts', `export const config = { x: 1 };\n`);
      await expect(loadAgentModule(file, true)).rejects.toThrow(
        /no-run\.ts.*does not export a valid "run" function/,
      );
    });
  });

  describe('与 loadToolModule 行为对称', () => {
    it('空文件 + hasRun=false → 返回 { run: undefined }', async () => {
      const file = writeFile('empty.ts', `// intentionally empty\n`);
      const result = await loadAgentModule(file, false);
      expect(result.run).toBeUndefined();
    });
  });
});
