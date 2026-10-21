import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadToolModule, type ToolModule } from './loadToolModule';

/**
 * loadToolModule 测试:动态加载 tool handler 模块,提取指定函数名导出
 *
 * 覆盖:
 * - 成功加载合法模块(具名导出函数)
 * - 默认导出对象属性也能解析
 * - 加载不存在的文件抛错
 * - 导出不是函数时抛错
 * - 缺少指定导出时抛错
 * - dev 按需编译模式:先 ensureCompiled 再 import(暂不测试,主流程在 compileOnDemand 测试覆盖)
 */
describe('loadToolModule', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(
      tmpdir(),
      `faapi-load-tool-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** 写入 fixture 文件(返回绝对路径) */
  function writeFile(relPath: string, content: string): string {
    const abs = join(tempDir, ...relPath.split('/'));
    mkdirSync(join(tempDir, ...relPath.split('/').slice(0, -1)), { recursive: true });
    writeFileSync(abs, content);
    return abs;
  }

  describe('成功加载', () => {
    it('加载具名导出函数(export function)', async () => {
      const file = writeFile(
        'weather.ts',
        `export function getWeather(input) { return 'sunny'; }\n`,
      );
      const result = await loadToolModule(file, 'getWeather');
      expect(result.functionName).toBe('getWeather');
      expect(typeof result.handler).toBe('function');
      expect(result.handler({ city: 'shanghai' })).toBe('sunny');
    });

    it('加载具名导出 async function', async () => {
      const file = writeFile(
        'data.ts',
        `export async function fetchData(input) { return 'data'; }\n`,
      );
      const result = await loadToolModule(file, 'fetchData');
      expect(typeof result.handler).toBe('function');
      expect(await result.handler({})).toBe('data');
    });

    it('加载具名导出箭头函数(export const = () =>)', async () => {
      const file = writeFile('ping.ts', `export const ping = () => 'pong';\n`);
      const result = await loadToolModule(file, 'ping');
      expect(result.functionName).toBe('ping');
      expect(result.handler()).toBe('pong');
    });

    it('加载具名导出 async 箭头函数', async () => {
      const file = writeFile('async.ts', `export const compute = async (input) => 42;\n`);
      const result = await loadToolModule(file, 'compute');
      expect(await result.handler({})).toBe(42);
    });

    it('默认导出对象的属性也能解析(export default { getWeather })', async () => {
      const file = writeFile(
        'default-obj.ts',
        `export default { getWeather(input) { return 'sunny'; } };\n`,
      );
      const result = await loadToolModule(file, 'getWeather');
      expect(typeof result.handler).toBe('function');
      expect(result.handler({})).toBe('sunny');
    });

    it('加载无参数的 tool 函数', async () => {
      const file = writeFile('ping.ts', `export function ping() { return 'pong'; }\n`);
      const result = await loadToolModule(file, 'ping');
      expect(result.handler()).toBe('pong');
    });

    it('ToolModule 类型包含 handler 和 functionName', async () => {
      const file = writeFile(
        'weather.ts',
        `export function getWeather(input) { return 'sunny'; }\n`,
      );
      const result: ToolModule = await loadToolModule(file, 'getWeather');
      expect(result).toHaveProperty('handler');
      expect(result).toHaveProperty('functionName');
      expect(result.functionName).toBe('getWeather');
    });
  });

  describe('错误处理', () => {
    it('加载不存在的文件抛错(包含文件路径和 functionName)', async () => {
      const file = join(tempDir, 'nonexistent.ts');
      await expect(loadToolModule(file, 'getWeather')).rejects.toThrow(
        /Failed to load tool module.*nonexistent\.ts/,
      );
    });

    it('导出不是函数时抛错(包含文件路径和 functionName)', async () => {
      const file = writeFile(
        'invalid-not-function.ts',
        `export const getWeather = 'not a function';\n`,
      );
      await expect(loadToolModule(file, 'getWeather')).rejects.toThrow(
        /invalid-not-function\.ts.*getWeather/,
      );
    });

    it('缺少指定导出时抛错', async () => {
      const file = writeFile('no-export.ts', `export function otherFn() { return 'ok'; }\n`);
      await expect(loadToolModule(file, 'getWeather')).rejects.toThrow(/no-export\.ts.*getWeather/);
    });

    it('空文件抛错(缺导出)', async () => {
      const file = writeFile('empty.ts', `// intentionally empty\n`);
      await expect(loadToolModule(file, 'getWeather')).rejects.toThrow(/empty\.ts.*getWeather/);
    });

    it('默认导出不是对象时,具名导出也缺失 → 抛错', async () => {
      const file = writeFile('default-not-obj.ts', `export default 'string default';\n`);
      await expect(loadToolModule(file, 'getWeather')).rejects.toThrow(
        /default-not-obj\.ts.*getWeather/,
      );
    });
  });

  describe('与 route module 加载行为对称', () => {
    it('functionName 与 method 不同——支持任意标识符', async () => {
      const file = writeFile(
        'mixed.ts',
        `export function camelCaseTool(input) { return 'ok'; }
export function snake_case_tool(input) { return 'ok'; }
export function PascalCaseTool(input) { return 'ok'; }
export function $dollarSign(input) { return 'ok'; }
`,
      );

      const r1 = await loadToolModule(file, 'camelCaseTool');
      expect(r1.handler({})).toBe('ok');

      const r2 = await loadToolModule(file, 'snake_case_tool');
      expect(r2.handler({})).toBe('ok');

      const r3 = await loadToolModule(file, 'PascalCaseTool');
      expect(r3.handler({})).toBe('ok');

      const r4 = await loadToolModule(file, '$dollarSign');
      expect(r4.handler({})).toBe('ok');
    });

    it('同文件多个 tool 函数都能独立加载', async () => {
      const file = writeFile(
        'math.ts',
        `export function add(input) { return input.a + input.b; }
export function multiply(input) { return input.a * input.b; }
`,
      );

      const addMod = await loadToolModule(file, 'add');
      const mulMod = await loadToolModule(file, 'multiply');
      expect(addMod.handler({ a: 1, b: 2 })).toBe(3);
      expect(mulMod.handler({ a: 3, b: 4 })).toBe(12);
      // 两者的 functionName 不同
      expect(addMod.functionName).toBe('add');
      expect(mulMod.functionName).toBe('multiply');
    });
  });
});
