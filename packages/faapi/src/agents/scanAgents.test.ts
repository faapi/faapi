import { describe, it, expect } from 'vitest';
import { scanAgents, DEFAULT_AGENT_PATTERNS } from './scanAgents';
import type { AgentManifest } from './agentTypes';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

/** 创建临时目录，返回 { dir, write, cleanup } 辅助函数 */
function setupTmp() {
  const dir = path.join(
    os.tmpdir(),
    `faapi-test-agents-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  fs.mkdirSync(dir, { recursive: true });
  const write = (rel: string, content: string) => {
    const abs = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  };
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  return { dir, write, cleanup };
}

describe('scanAgents', () => {
  it('扫描 src/agents/<name>/handler.ts 并提取 agent 名', async () => {
    const { dir, write, cleanup } = setupTmp();
    write(
      'src/agents/researcher/handler.ts',
      'export const config = { systemPrompt: "research" };\n',
    );
    try {
      const agents = await scanAgents(dir, DEFAULT_AGENT_PATTERNS);
      expect(agents).toHaveLength(1);
      expect(agents[0]).toMatchObject({
        name: 'researcher',
        filePath: 'src/agents/researcher/handler.ts',
        hasRun: false,
      });
    } finally {
      cleanup();
    }
  });

  it('检测 run 导出（export function run）', async () => {
    const { dir, write, cleanup } = setupTmp();
    write('src/agents/researcher/handler.ts', 'export function run(input) { return "result"; }\n');
    try {
      const agents = await scanAgents(dir, DEFAULT_AGENT_PATTERNS);
      expect(agents[0]!.hasRun).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('检测 run 导出（export async function run）', async () => {
    const { dir, write, cleanup } = setupTmp();
    write(
      'src/agents/researcher/handler.ts',
      'export async function run(input) { return "result"; }\n',
    );
    try {
      const agents = await scanAgents(dir, DEFAULT_AGENT_PATTERNS);
      expect(agents[0]!.hasRun).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('检测 run 导出（export const run = 箭头函数）', async () => {
    const { dir, write, cleanup } = setupTmp();
    write('src/agents/researcher/handler.ts', 'export const run = (input) => "result";\n');
    try {
      const agents = await scanAgents(dir, DEFAULT_AGENT_PATTERNS);
      expect(agents[0]!.hasRun).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('检测 run 导出（export const run = async 箭头函数）', async () => {
    const { dir, write, cleanup } = setupTmp();
    write('src/agents/researcher/handler.ts', 'export const run = async (input) => "result";\n');
    try {
      const agents = await scanAgents(dir, DEFAULT_AGENT_PATTERNS);
      expect(agents[0]!.hasRun).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('同时导出 config 和 run', async () => {
    const { dir, write, cleanup } = setupTmp();
    write(
      'src/agents/researcher/handler.ts',
      'export const config = { systemPrompt: "x" };\n' +
        'export async function run(input) { return "result"; }\n',
    );
    try {
      const agents = await scanAgents(dir, DEFAULT_AGENT_PATTERNS);
      expect(agents).toHaveLength(1);
      expect(agents[0]!.hasRun).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('既无 config 也无 run（空 agent——tool 容器）', async () => {
    const { dir, write, cleanup } = setupTmp();
    write('src/agents/empty/handler.ts', '// no config, no run\n');
    try {
      const agents = await scanAgents(dir, DEFAULT_AGENT_PATTERNS);
      expect(agents).toHaveLength(1);
      expect(agents[0]!.hasRun).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('不匹配非 config/run 的相似名（configuration / runtime）', async () => {
    const { dir, write, cleanup } = setupTmp();
    write(
      'src/agents/researcher/handler.ts',
      'export const configuration = { x: 1 };\n' +
        'export const runtime = () => "x";\n' +
        'export const config2 = {};\n',
    );
    try {
      const agents = await scanAgents(dir, DEFAULT_AGENT_PATTERNS);
      expect(agents[0]!.hasRun).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('扫描多个 agent', async () => {
    const { dir, write, cleanup } = setupTmp();
    write('src/agents/researcher/handler.ts', 'export const config = {};\n');
    write('src/agents/coder/handler.ts', 'export function run() { return "ok"; }\n');
    write(
      'src/agents/writer/handler.ts',
      'export const config = {};\nexport function run() { return "ok"; }\n',
    );
    try {
      const agents = await scanAgents(dir, DEFAULT_AGENT_PATTERNS);
      expect(agents).toHaveLength(3);
      const byName = new Map(agents.map((a) => [a.name, a]));
      expect(byName.get('researcher')?.hasRun).toBe(false);
      expect(byName.get('coder')?.hasRun).toBe(true);
      expect(byName.get('writer')?.hasRun).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('同 agent 名重复报错', async () => {
    const { dir, write, cleanup } = setupTmp();
    write('src/agents/researcher/handler.ts', 'export const config = {};\n');
    write('backup/agents/researcher/handler.ts', 'export const config = {};\n');
    try {
      await expect(
        scanAgents(dir, ['src/agents/*/handler.ts', 'backup/agents/*/handler.ts']),
      ).rejects.toThrow(/researcher/);
    } finally {
      cleanup();
    }
  });

  it('空目录返回空数组', async () => {
    const { dir, cleanup } = setupTmp();
    try {
      const agents = await scanAgents(dir, DEFAULT_AGENT_PATTERNS);
      expect(agents).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('仅扫描 handler.ts，忽略同目录其他 .ts 文件', async () => {
    const { dir, write, cleanup } = setupTmp();
    write('src/agents/researcher/handler.ts', 'export const config = {};\n');
    write('src/agents/researcher/types.ts', 'export interface Config {};\n');
    write('src/agents/researcher/util.ts', 'export function helper() {};\n');
    try {
      const agents = await scanAgents(dir, ['src/agents/*/handler.ts']);
      expect(agents).toHaveLength(1);
      expect(agents[0]!.name).toBe('researcher');
    } finally {
      cleanup();
    }
  });

  it('默认 pattern 支持多级嵌套目录，名字规范化为点号', async () => {
    const { dir, write, cleanup } = setupTmp();
    write('src/agents/easy-writing/wizard/handler.ts', 'export const config = {};\n');
    write('src/agents/a/b/c/deep/handler.ts', 'export const config = {};\n');
    try {
      const agents = await scanAgents(dir, DEFAULT_AGENT_PATTERNS);
      expect(agents).toHaveLength(2);
      const byName = new Map(agents.map((a) => [a.name, a]));
      expect(byName.get('easy-writing.wizard')?.filePath).toBe(
        'src/agents/easy-writing/wizard/handler.ts',
      );
      expect(byName.get('a.b.c.deep')?.filePath).toBe('src/agents/a/b/c/deep/handler.ts');
    } finally {
      cleanup();
    }
  });

  it('嵌套与平铺混合扫描，重名跨层级检测生效', async () => {
    const { dir, write, cleanup } = setupTmp();
    write('src/agents/researcher/handler.ts', 'export const config = {};\n');
    write('src/agents/researcher/sub/handler.ts', 'export const config = {};\n');
    write('src/agents/other/deep/handler.ts', 'export const config = {};\n');
    try {
      const agents = await scanAgents(dir, DEFAULT_AGENT_PATTERNS);
      expect(agents).toHaveLength(3);
      const byName = new Map(agents.map((a) => [a.name, a]));
      expect(byName.has('researcher')).toBe(true);
      expect(byName.has('researcher.sub')).toBe(true);
      expect(byName.has('other.deep')).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('嵌套同子路径重名报错', async () => {
    const { dir, write, cleanup } = setupTmp();
    write('src/agents/group/wizard/handler.ts', 'export const config = {};\n');
    write('backup/agents/group/wizard/handler.ts', 'export const config = {};\n');
    try {
      await expect(
        scanAgents(dir, ['src/agents/**/handler.ts', 'backup/agents/**/handler.ts']),
      ).rejects.toThrow(/group\.wizard/);
    } finally {
      cleanup();
    }
  });

  it('AgentManifest 类型完整：所有字段存在', async () => {
    const { dir, write, cleanup } = setupTmp();
    write(
      'src/agents/researcher/handler.ts',
      'export const config = {};\nexport function run() { return "ok"; }\n',
    );
    try {
      const agents = await scanAgents(dir, DEFAULT_AGENT_PATTERNS);
      const agent: AgentManifest = agents[0]!;
      expect(agent).toHaveProperty('name');
      expect(agent).toHaveProperty('filePath');
      expect(agent).toHaveProperty('hasRun');
    } finally {
      cleanup();
    }
  });
});
