import path from 'node:path';
import fs from 'node:fs/promises';
import type { AgentManifestList } from '../agents/agentTypes';
import type { AgentMetadata } from '../ast/extractAgentMetadata';
import { extractAgentMetadata } from '../ast/extractAgentMetadata';
import { createPrograms } from '../ast/createProgram';

/**
 * 序列化的 agent manifest 记录（可写入 JS 模块，无函数引用）
 *
 * 与 [AgentMetadata](../ast/extractAgentMetadata.md) 字段一一对应，仅 `filePath`
 * 由源码形式（`src/...`）转为产物形式（`<dist>/...`，打平 `src/` 前缀 + dist 前缀 + `.js`）。
 *
 * `undefined` 字段（description / systemPrompt / tools / agents / model / maxTurns）
 * 在 JSON.stringify 时自动省略，水合时通过 `??` 兜底为 undefined。
 *
 * > `hasConfig` 字段已移除——它原本用于控制 `loadAgentModule` 是否提取 `config` 对象,
 * > 但 `AgentModule.config` 已废弃(`executeSubAgent` 拿到后从不读取),属于死链路。
 */
export interface SerializedAgentRecord {
  /** agent 名（`@agent` 覆盖值 或 目录推导值） */
  name: string;
  /** JSDoc 描述（对 LLM 可见），无则省略 */
  description?: string;
  /** 是否导出 run 函数（从 manifest 透传） */
  hasRun: boolean;
  /** 系统提示词（config 块字面量提取），无/非字面量时省略 */
  systemPrompt?: string;
  /** agent 显式声明可用的 tool 引用列表（config 块字面量提取），无/含非字面量元素时省略 */
  tools?: string[];
  /** 可调用的其他 agent 名列表（config 块字面量提取），无/含非字面量元素时省略 */
  agents?: string[];
  /** LLM 模型名（config 块字面量提取），无/非字面量时省略 */
  model?: string;
  /** 最大对话轮数（config 块字面量提取），无/非字面量时省略 */
  maxTurns?: number;
  /** 产物形式路径（如 `dist/agents/researcher/handler.js`），供运行时 import agent.js */
  filePath: string;
}

/**
 * faapi-agents.js 文件名（与 faapi-routes.js / faapi-tools.js 同构）
 */
const AGENTS_FILE = 'faapi-agents.js';

/**
 * 把源码 filePath（`src/agents/researcher/handler.ts`）转为产物路径（`<dist>/agents/researcher/handler.js`）
 *
 * 产物结构打平 `src/` 前缀：去掉 `src/`，加 dist 前缀，`.ts` → `.js`。
 *
 * 与 [generateToolArtifacts.toProdFilePath](./generateToolArtifacts.md) 同构，
 * 区别仅在于 tool 在 `tools/` 子路径，agent 在 `agents/` 子路径。
 */
function toProdFilePath(filePath: string, dist: string): string {
  let rel = filePath.replace(/\\/g, '/');
  if (rel.startsWith('src/')) {
    rel = rel.slice(4);
  }
  const jsPath = rel.replace(/\.ts$/, '.js');
  return jsPath.startsWith(`${dist}/`) ? jsPath : `${dist}/${jsPath}`;
}

/**
 * 序列化 agent 清单为可写入 JS 模块的结构
 *
 * - `filePath` 转为产物形式（打平 `src/` 前缀 + dist 前缀 + `.js`）
 * - 其他字段（name/description/hasRun/systemPrompt/tools/agents/model/maxTurns）直接透传
 * - `undefined` 字段在 JSON.stringify 时自动省略
 *
 * @param agents AST 增强后的 AgentMetadata[]（由 generateAgentArtifacts 内部从 AgentManifest 增强）
 * @param dist 产物目录（默认 `dist`），用于转换 filePath
 */
export function serializeAgents(
  agents: AgentMetadata[],
  dist: string = 'dist',
): SerializedAgentRecord[] {
  return agents.map((a) => ({
    name: a.name,
    description: a.description,
    hasRun: a.hasRun,
    systemPrompt: a.systemPrompt,
    tools: a.tools,
    agents: a.agents,
    model: a.model,
    maxTurns: a.maxTurns,
    filePath: toProdFilePath(a.filePath, dist),
  }));
}

/**
 * 把序列化的 agent 清单写入 faapi-agents.js
 *
 * 生成 ESM 模块，运行时 `createAppCore` 通过 `importWithCacheBust` 加载。
 * 用 JSON.stringify 嵌入，保证字符串转义安全（与 `writeRoutesModule` / `writeToolsModule` 一致）。
 */
export async function writeAgentsModule(
  manifest: SerializedAgentRecord[],
  outputPath: string,
): Promise<void> {
  const dir = path.dirname(outputPath);
  await fs.mkdir(dir, { recursive: true });

  const content = `// 自动生成,请勿手动编辑(faapi build/dev 产物)
export const agents = ${JSON.stringify(manifest, null, 2)};
`;
  await fs.writeFile(outputPath, content, 'utf-8');
}

/**
 * 从序列化清单水合还原 AgentMetadata[]
 *
 * 字段一一对应（无函数引用需还原）。`undefined` 字段在 JSON.parse 时缺失，
 * 通过 `??` 兜底为 undefined（保证 `AgentMetadata` 类型完整）。
 */
export function hydrateAgents(manifest: SerializedAgentRecord[]): AgentMetadata[] {
  return manifest.map((a) => ({
    name: a.name,
    description: a.description ?? undefined,
    filePath: a.filePath,
    hasRun: a.hasRun,
    systemPrompt: a.systemPrompt ?? undefined,
    tools: a.tools ?? undefined,
    agents: a.agents ?? undefined,
    model: a.model ?? undefined,
    maxTurns: a.maxTurns ?? undefined,
  }));
}

/**
 * 主入口：从 AgentManifest[] 生成 faapi-agents.js
 *
 * agent **不生成 zod.js**——与 tool 不同，agent 没有用户输入参数（config 块字段
 * 已在 [extractAgentMetadata](../ast/extractAgentMetadata.md) AST 阶段提取为字面量），
 * 运行时无需 schema 校验。`run` 函数参数由 [agentRegistry](../injection/agentRegistry.md)
 * 的 `asTool()` 在 Phase 2.2 处理（若需输入校验，由 agent 子包在 Phase 3.x 自行生成）。
 *
 * 内部流程：
 * 1. 对每个 AgentManifest 调 `createProgram` + `extractAgentMetadata` → AgentMetadata[]
 *    （AST 增强：补全 description / `@agent` 覆盖名 / config 块字段）
 * 2. `serializeAgents(metadata, dist)` → SerializedAgentRecord[]（filePath 转产物形式）
 * 3. `writeAgentsModule(serialized, faapiAgentsPath)` → 写入 `<dist>/faapi-agents.js`
 *
 * 与 [generateToolArtifacts](./generateToolArtifacts.md) 的差异：
 * - 不生成 zod.js（agent 无输入参数）
 * - 无 `skipSchema` 选项（没有 schema 可跳过）
 * - 文件名常量为 `faapi-agents.js`，导出 `agents` 而非 `tools`
 *
 * @param agents scanAgents 产出的 AgentManifest[]（仅路径推导字段）
 * @param rootDir 项目根目录
 * @param dist 产物目录（`.faapi` 或 `dist`）
 * @returns AST 增强后的 AgentMetadata[]（供调用方日志/调试）
 */
export async function generateAgentArtifacts(
  agents: AgentManifestList,
  rootDir: string,
  dist: string,
): Promise<AgentMetadata[]> {
  // 1. AST 增强：对每个 manifest 调 extractAgentMetadata（批量共享 Program）
  const metadata: AgentMetadata[] = [];
  const programByFile = createPrograms(agents.map((m) => path.resolve(rootDir, m.filePath)));
  for (const manifest of agents) {
    const absPath = path.resolve(rootDir, manifest.filePath);
    const program = programByFile.get(absPath)!;
    const result = extractAgentMetadata(program, absPath, {
      name: manifest.name,
      filePath: manifest.filePath,
      hasRun: manifest.hasRun,
    });
    if (result) {
      metadata.push(result);
    }
  }

  // 2. 序列化 + 写入 faapi-agents.js
  const serialized = serializeAgents(metadata, dist);
  const agentsPath = path.resolve(rootDir, dist, AGENTS_FILE);
  await writeAgentsModule(serialized, agentsPath);

  return metadata;
}
