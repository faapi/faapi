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
        hasConfig: true,
        hasRun: false,
      });
    } finally {
      cleanup();
    }
  });

  it('检测 config 导出（export const config）', async () => {
    const { dir, write, cleanup } = setupTmp();
    write(
      'src/agents/researcher/handler.ts',
      'export const config = { systemPrompt: "x", model: "gpt-4" };\n',
    );
    try {
      const agents = await scanAgents(dir, DEFAULT_AGENT_PATTERNS);
      expect(agents[0]!.hasConfig).toBe(true);
      expect(agents[0]!.hasRun).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('检测 config 导出（export function config）', async () => {
    const { dir, write, cleanup } = setupTmp();
    write(
      'src/agents/researcher/handler.ts',
      'export function config() { return { systemPrompt: "x" }; }\n',
    );
    try {
      const agents = await scanAgents(dir, DEFAULT_AGENT_PATTERNS);
      expect(agents[0]!.hasConfig).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('检测 run 导出（export function run）', async () => {
    const { dir, write, cleanup } = setupTmp();
    write('src/agents/researcher/handler.ts', 'export function run(input) { return "result"; }\n');
    try {
      const agents = await scanAgents(dir, DEFAULT_AGENT_PATTERNS);
      expect(agents[0]!.hasConfig).toBe(false);
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
      expect(agents[0]!.hasConfig).toBe(true);
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
      expect(agents[0]!.hasConfig).toBe(false);
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
      expect(agents[0]!.hasConfig).toBe(false);
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
      expect(byName.get('researcher')?.hasConfig).toBe(true);
      expect(byName.get('researcher')?.hasRun).toBe(false);
      expect(byName.get('coder')?.hasConfig).toBe(false);
      expect(byName.get('coder')?.hasRun).toBe(true);
      expect(byName.get('writer')?.hasConfig).toBe(true);
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

  it('glob * 不跨 /，仅匹配一级目录', async () => {
    const { dir, write, cleanup } = setupTmp();
    write('src/agents/researcher/handler.ts', 'export const config = {};\n');
    // 嵌套目录不应匹配 src/agents/*/handler.ts
    write('src/agents/researcher/sub/handler.ts', 'export const config = {};\n');
    try {
      const agents = await scanAgents(dir, DEFAULT_AGENT_PATTERNS);
      expect(agents).toHaveLength(1);
      expect(agents[0]!.name).toBe('researcher');
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
      expect(agent).toHaveProperty('hasConfig');
      expect(agent).toHaveProperty('hasRun');
    } finally {
      cleanup();
    }
  });
});
