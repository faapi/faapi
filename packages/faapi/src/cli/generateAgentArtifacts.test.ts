import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  writeAgentsModule,
  generateAgentArtifacts,
  type SerializedAgentRecord,
} from './generateAgentArtifacts';
import { importWithCacheBust } from '../utils/importWithCacheBust';
import type { AgentManifest } from '../agents/agentTypes';
import { invalidateProgramCache } from '../ast/createProgram';

/**
 * generateAgentArtifacts 测试：定位清单 faapi-agents.js + Input zod.js（清单仅做定位，
 * config 块在运行时启动期求值）
 *
 * 覆盖：
 * - Input 导出正则检测 → inputTypeName 标记 + zod.js 生成（共享管线，coerce=false）
 * - 未声明 Input → 单字段交接单模式（无 zod.js、无 inputTypeName）
 * - skipSchema（测试设施 free-form 模式）
 * - 定位清单写入（filePath 转产物形式 / dev .faapi 形态 / 空清单）
 * - writeAgentsModule：JSON 嵌入格式与运行时 import 往返
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

  /** 写一个 agent handler fixture（可选 Input 类型导出） */
  function writeAgent(
    name: string,
    opts: { withInput?: boolean; configSource?: string } = {},
  ): AgentManifest {
    const dir = join(tempDir, 'src', 'agents', name);
    mkdirSync(dir, { recursive: true });
    const inputDecl = opts.withInput
      ? '\nexport interface Input { topic: string; limit?: number }\n'
      : '';
    const configSource =
      opts.configSource ?? `export const config = { systemPrompt: 'You are ${name}' };`;
    writeFileSync(join(dir, 'handler.ts'), configSource + inputDecl);
    return { name, filePath: `src/agents/${name}/handler.ts` };
  }

  // ─── Input 检测与 zod.js 生成 ─────────────────────────────────────────

  it('声明 Input 的 agent 生成 zod.js + 清单标记 inputTypeName', async () => {
    const a = writeAgent('researcher', { withInput: true });
    const records = await generateAgentArtifacts([a], tempDir, 'dist');

    expect(records).toHaveLength(1);
    expect(records[0]!.inputTypeName).toBe('Input');
    expect(records[0]!.filePath).toBe('dist/agents/researcher/handler.js');
    expect(existsSync(join(tempDir, 'dist', 'agents', 'researcher', 'zod.js'))).toBe(true);
  });

  it('未声明 Input 的 agent 无 zod.js、无 inputTypeName（单字段交接单模式）', async () => {
    const a = writeAgent('writer');
    const records = await generateAgentArtifacts([a], tempDir, 'dist');

    expect(records).toHaveLength(1);
    expect(records[0]!.inputTypeName).toBeUndefined();
    expect(existsSync(join(tempDir, 'dist', 'agents', 'writer', 'zod.js'))).toBe(false);
  });

  it('type Input 别名形态同样被检测', async () => {
    const dir = join(tempDir, 'src', 'agents', 'aliasing');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'handler.ts'),
      "export const config = { systemPrompt: 'x' };\nexport type Input = { q: string };\n",
    );
    const records = await generateAgentArtifacts(
      [{ name: 'aliasing', filePath: 'src/agents/aliasing/handler.ts' }],
      tempDir,
      'dist',
    );
    expect(records[0]!.inputTypeName).toBe('Input');
  });

  it('混合场景：仅声明 Input 的 agent 生成 zod.js，其余跳过（零 AST 成本）', async () => {
    const withInput = writeAgent('with-input', { withInput: true });
    const withoutInput = writeAgent('no-input');
    const records = await generateAgentArtifacts([withInput, withoutInput], tempDir, 'dist');

    expect(records).toHaveLength(2);
    expect(existsSync(join(tempDir, 'dist', 'agents', 'with-input', 'zod.js'))).toBe(true);
    expect(existsSync(join(tempDir, 'dist', 'agents', 'no-input', 'zod.js'))).toBe(false);
    expect(records.find((r) => r.name === 'with-input')?.inputTypeName).toBe('Input');
    expect(records.find((r) => r.name === 'no-input')?.inputTypeName).toBeUndefined();
  });

  it('skipSchema 跳过 zod.js 生成（测试设施 free-form 模式），清单照常写入', async () => {
    const a = writeAgent('researcher', { withInput: true });
    const records = await generateAgentArtifacts([a], tempDir, 'dist', { skipSchema: true });

    expect(records[0]!.inputTypeName).toBe('Input');
    expect(existsSync(join(tempDir, 'dist', 'agents', 'researcher', 'zod.js'))).toBe(false);
  });

  it('生成的 zod.js 导出 InputSchema（coerce=false——LLM JSON 入参）', async () => {
    const a = writeAgent('researcher', { withInput: true });
    await generateAgentArtifacts([a], tempDir, 'dist');

    const zodSource = readFileSync(
      join(tempDir, 'dist', 'agents', 'researcher', 'zod.js'),
      'utf-8',
    );
    expect(zodSource).toContain('InputSchema');
    expect(zodSource).toContain('// agent researcher → Input');
  });

  // ─── 定位清单 ─────────────────────────────────────────────────────────

  it('空 manifest 写入空清单', async () => {
    const records = await generateAgentArtifacts([], tempDir, 'dist');
    expect(records).toEqual([]);

    const mod = (await importWithCacheBust(join(tempDir, 'dist', 'faapi-agents.js'))) as {
      agents: SerializedAgentRecord[];
    };
    expect(mod.agents).toEqual([]);
  });

  it('dev 模式 dist 为 .faapi，filePath 转产物形式', async () => {
    const a = writeAgent('writer');
    const records = await generateAgentArtifacts([a], tempDir, '.faapi');
    expect(records[0]!.filePath).toBe('.faapi/agents/writer/handler.js');
  });

  it('生成的清单经运行时 import 往返还原（含 Input 标记）', async () => {
    const a = writeAgent('researcher', { withInput: true });
    const b = writeAgent('writer');
    await generateAgentArtifacts([a, b], tempDir, 'dist');

    const mod = (await importWithCacheBust(join(tempDir, 'dist', 'faapi-agents.js'))) as {
      agents: SerializedAgentRecord[];
    };
    expect(mod.agents).toHaveLength(2);
    const researcher = mod.agents.find((r) => r.name === 'researcher');
    const writer = mod.agents.find((r) => r.name === 'writer');
    expect(researcher).toEqual({
      name: 'researcher',
      filePath: 'dist/agents/researcher/handler.js',
      inputTypeName: 'Input',
    });
    expect(writer).toEqual({
      name: 'writer',
      filePath: 'dist/agents/writer/handler.js',
    });
  });

  // ─── writeAgentsModule ────────────────────────────────────────────────

  it('writeAgentsModule 生成带 do-not-edit 头注释的 ESM 模块', async () => {
    const records: SerializedAgentRecord[] = [
      { name: 'researcher', filePath: 'dist/agents/researcher/handler.js' },
    ];
    const out = join(tempDir, 'faapi-agents.js');
    await writeAgentsModule(records, out);

    const source = readFileSync(out, 'utf-8');
    expect(source).toContain('自动生成,请勿手动编辑');
    expect(source).toContain('export const agents');
    expect(source).toContain('"name": "researcher"');
  });
});
