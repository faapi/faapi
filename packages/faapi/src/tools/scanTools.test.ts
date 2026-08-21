import { describe, it, expect } from 'vitest';
import { scanTools } from './scanTools';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

/** 创建临时目录,返回 { dir, file, write } 辅助函数 */
function setupTmp() {
  const dir = path.join(
    os.tmpdir(),
    `faapi-test-tools-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  fs.mkdirSync(dir, { recursive: true });
  const file = (rel: string) => path.join(dir, ...rel.split('/'));
  const write = (rel: string, content: string) => {
    fs.mkdirSync(path.dirname(file(rel)), { recursive: true });
    fs.writeFileSync(file(rel), content);
  };
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  return { dir, file, write, cleanup };
}

describe('scanTools', () => {
  it('扫描共享 tool(src/tools/)', async () => {
    const { dir, write, cleanup } = setupTmp();
    write('src/tools/weather/handler.ts', 'export function getWeather(input) { return "sunny"; }');
    try {
      const tools = await scanTools(dir, ['src/tools/**/*.ts']);
      expect(tools).toHaveLength(1);
      expect(tools[0]).toMatchObject({
        name: 'weather.getWeather',
        functionName: 'getWeather',
        filePath: 'src/tools/weather/handler.ts',
      });
    } finally {
      cleanup();
    }
  });

  it('一个 handler.ts 导出多个函数 → 多个 manifest', async () => {
    const { dir, write, cleanup } = setupTmp();
    write(
      'src/tools/math/handler.ts',
      'export function add(a, b) { return a + b; }\nexport function multiply(a, b) { return a * b; }',
    );
    try {
      const tools = await scanTools(dir, ['src/tools/**/*.ts']);
      expect(tools).toHaveLength(2);
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual(['math.add', 'math.multiply']);
    } finally {
      cleanup();
    }
  });

  it('无子目录时 tool 名为纯函数名', async () => {
    const { dir, write, cleanup } = setupTmp();
    write('src/tools/handler.ts', 'export function ping() { return "pong"; }');
    try {
      const tools = await scanTools(dir, ['src/tools/**/*.ts']);
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('ping');
      expect(tools[0].filePath).toBe('src/tools/handler.ts');
    } finally {
      cleanup();
    }
  });

  it('支持 export async function', async () => {
    const { dir, write, cleanup } = setupTmp();
    write('src/tools/data/handler.ts', 'export async function fetch(input) { return "data"; }');
    try {
      const tools = await scanTools(dir, ['src/tools/**/*.ts']);
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('data.fetch');
    } finally {
      cleanup();
    }
  });

  it('支持 export const = 箭头函数(含 async)', async () => {
    const { dir, write, cleanup } = setupTmp();
    write(
      'src/tools/calc/handler.ts',
      'export const sum = (a, b) => a + b;\nexport const asyncQuery = async (input) => "result";',
    );
    try {
      const tools = await scanTools(dir, ['src/tools/**/*.ts']);
      expect(tools).toHaveLength(2);
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual(['calc.asyncQuery', 'calc.sum']);
    } finally {
      cleanup();
    }
  });

  it('排除保留导出名(default/config/run)', async () => {
    const { dir, write, cleanup } = setupTmp();
    write(
      'src/tools/helper/handler.ts',
      'export function config() { return {}; }\n' +
        'export function run() { return "ok"; }\n' +
        'export default function() { return "default"; }\n' +
        'export function actualTool(input) { return "ok"; }',
    );
    try {
      const tools = await scanTools(dir, ['src/tools/**/*.ts']);
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('helper.actualTool');
    } finally {
      cleanup();
    }
  });

  it('排除非函数导出(interface/type)', async () => {
    const { dir, write, cleanup } = setupTmp();
    write(
      'src/tools/weather/handler.ts',
      'export interface WeatherInput { city: string; }\n' +
        'export type WeatherCode = string;\n' +
        'export function getWeather(input: WeatherInput) { return "sunny"; }',
    );
    try {
      const tools = await scanTools(dir, ['src/tools/**/*.ts']);
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('weather.getWeather');
    } finally {
      cleanup();
    }
  });

  it('同作用域(共享池)同名 tool 报错', async () => {
    const { dir, write, cleanup } = setupTmp();
    // 两个不同根目录的 tools/ 都产生 weather.getWeather
    write('src/tools/weather/handler.ts', 'export function getWeather(input) { return "a"; }');
    write('backup/tools/weather/handler.ts', 'export function getWeather(input) { return "b"; }');
    try {
      await expect(scanTools(dir, ['src/tools/**/*.ts', 'backup/tools/**/*.ts'])).rejects.toThrow(
        /weather\.getWeather/,
      );
    } finally {
      cleanup();
    }
  });

  it('空目录返回空数组', async () => {
    const { dir, cleanup } = setupTmp();
    try {
      const tools = await scanTools(dir, ['src/tools/**/*.ts']);
      expect(tools).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('多层子目录命名空间用 . 连接', async () => {
    const { dir, write, cleanup } = setupTmp();
    write('src/tools/a/b/handler.ts', 'export function deep(input) { return "ok"; }');
    try {
      const tools = await scanTools(dir, ['src/tools/**/*.ts']);
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('a.b.deep');
    } finally {
      cleanup();
    }
  });

  it('仅扫描 handler.ts,忽略同目录其他 .ts 文件', async () => {
    const { dir, write, cleanup } = setupTmp();
    write('src/tools/weather/handler.ts', 'export function getWeather(input) { return "sunny"; }');
    write('src/tools/weather/types.ts', 'export interface WeatherInput { city: string; }');
    write('src/tools/weather/util.ts', 'export function helper() { return "helper"; }');
    try {
      const tools = await scanTools(dir, ['src/tools/**/*.ts']);
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('weather.getWeather');
    } finally {
      cleanup();
    }
  });
});
