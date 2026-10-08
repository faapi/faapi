import path from 'node:path';
import type { AgentManifestList } from '../agents/agentTypes';
import type { AgentMetadata } from '../ast/extractAgentMetadata';
import { extractAgentMetadata } from '../ast/extractAgentMetadata';
import { createPrograms } from '../ast/createProgram';
import { toProdFilePath } from '../utils/prodPaths';
import { atomicWriteFile } from '../utils/atomicWrite';
import {
  extractTypeInfo,
  createLazyTypeResolver,
  type HandlerTypeInfo,
  type LazyTypeResolver,
} from '../ast/extractHandlerTypes';
import type { RuntimeType } from '../ast/resolveTypeNode';
import { generateZodSchemaSource, usesCoerceHelpers } from '../ast/generateZodSchema';
import { generateZodArtifacts } from './generateZodArtifacts';

/**
 * 序列化的 agent manifest 记录（可写入 JS 模块，无函数引用）
 *
 * 与 [AgentMetadata](../ast/extractAgentMetadata.md) 字段一一对应，仅 `filePath`
 * 由源码形式（`src/...`）转为产物形式（`<dist>/...`，打平 `src/` 前缀 + dist 前缀 + `.js`）。
 *
 * `undefined` 字段（description / systemPrompt / tools / agents / model / maxTurns /
 * inputDescription / inputTypeName）在 JSON.stringify 时自动省略，水合时通过 `??`
 * 兜底为 undefined。
 *
 * > `hasConfig` / `hasRun` 字段已移除——自定义 run 机制已整体移除，agent 统一为
 * > 声明式执行（config + 默认 reactLoop）。
 */
export interface SerializedAgentRecord {
  /** agent 名（`@agent` 覆盖值 或 目录推导值） */
  name: string;
  /** JSDoc 描述（对 LLM 可见），无则省略 */
  description?: string;
  /** 系统提示词（config 块字面量提取），无/非字面量时省略 */
  systemPrompt?: string;
  /** 系统提示词文件路径（相对产物 resources 目录，config 块字面量提取），与 systemPrompt 互斥，无时省略 */
  systemPromptFile?: string;
  /** agent 显式声明可用的 tool 引用列表（config 块字面量提取），无/含非字面量元素时省略 */
  tools?: string[];
  /** 可调用的其他 agent 名列表（config 块字面量提取），无/含非字面量元素时省略 */
  agents?: string[];
  /** LLM 模型名（config 块字面量提取），无/非字面量时省略 */
  model?: string;
  /** 最大对话轮数（config 块字面量提取），无/非字面量时省略 */
  maxTurns?: number;
  /** agent-as-tool 派发交接单说明（config 块字面量提取），无/非字面量时省略 */
  inputDescription?: string;
  /** 派发入参 schema 声明（handler.ts 顶层 Input 导出检测），无则省略 */
  inputTypeName?: string;
  /** 产物形式路径（如 `dist/agents/researcher/handler.js`），声明文件定位与可观测性用 */
  filePath: string;
}

/**
 * faapi-agents.js 文件名（与 faapi-routes.js / faapi-tools.js 同构）
 */
const AGENTS_FILE = 'faapi-agents.js';

/**
 * 序列化 agent 清单为可写入 JS 模块的结构
 *
 * - `filePath` 转为产物形式（打平 `src/` 前缀 + dist 前缀 + `.js`）
 * - 其他字段（name/description/systemPrompt/tools/agents/model/maxTurns/inputDescription）直接透传
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
    systemPrompt: a.systemPrompt,
    systemPromptFile: a.systemPromptFile,
    tools: a.tools,
    agents: a.agents,
    model: a.model,
    maxTurns: a.maxTurns,
    inputDescription: a.inputDescription,
    inputTypeName: a.inputTypeName,
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
  const content = `// 自动生成,请勿手动编辑(faapi build/dev 产物)
export const agents = ${JSON.stringify(manifest, null, 2)};
`;
  await atomicWriteFile(outputPath, content);
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
    systemPrompt: a.systemPrompt ?? undefined,
    systemPromptFile: a.systemPromptFile ?? undefined,
    tools: a.tools ?? undefined,
    agents: a.agents ?? undefined,
    model: a.model ?? undefined,
    maxTurns: a.maxTurns ?? undefined,
    inputDescription: a.inputDescription ?? undefined,
    inputTypeName: a.inputTypeName ?? undefined,
  }));
}

/**
 * 清单级校验：跨 agent 组合才暴露的问题，静默水合会让注册表处于与声明意图不符的状态
 *
 * - **agent 名重复**——水合语义是后者覆盖前者，静默覆盖丢失 agent
 * - **`agents` 引用不存在的 agent 名**——sub-agent 递归到运行时首次调用才失败，
 *   错误被推迟且不带构建上下文
 *
 * `tools` 引用不做构建期校验——业务方 plugin 可在运行时注册额外 tool
 * （`PluginContext.registries`），构建期校验会误报。
 */
function validateAgentList(metadata: AgentMetadata[]): void {
  const names = new Map<string, string>();
  for (const a of metadata) {
    const prev = names.get(a.name);
    if (prev) {
      throw new Error(
        `agent 名重复: "${a.name}"（${prev} 与 ${a.filePath} 冲突——目录推导名或 @agent 覆盖名撞名）`,
      );
    }
    names.set(a.name, a.filePath);
  }

  for (const a of metadata) {
    for (const ref of a.agents ?? []) {
      if (!names.has(ref)) {
        const available = [...names.keys()].join(', ') || '无';
        throw new Error(
          `agent "${a.name}" 的 agents 引用了不存在的 agent: "${ref}"（清单中可用: ${available}）`,
        );
      }
    }
  }
}

/**
 * 主入口：从 AgentManifest[] 生成 faapi-agents.js + 声明 `Input` 的 agent zod.js
 *
 * 内部流程：
 * 1. 对每个 AgentManifest 调 `createProgram` + `extractAgentMetadata` → AgentMetadata[]
 *    （AST 增强：补全 description / `@agent` 覆盖名 / config 块字段 / inputTypeName）
 * 2. `validateAgentList` 清单级校验（名重复 / agents 互引存在性）
 * 3. `serializeAgents(metadata, dist)` → SerializedAgentRecord[]（filePath 转产物形式）
 * 4. `writeAgentsModule(serialized, faapiAgentsPath)` → 写入 `<dist>/faapi-agents.js`
 * 5. 声明 `inputTypeName` 的 agent 生成 `<dist>/agents/<name>/zod.js`（导出 `InputSchema`，
 *    coerce=false——入参来自 LLM JSON 调用，与 tool/task 同语义）
 *
 * **zod.js 生成与 tool/task 复用同一共享管线**（[generateZodArtifacts](./generateZodArtifacts.md)），
 * 类型提取**复用步骤 1 已创建的 Program**（零额外解析成本）。
 *
 * **dev/prod 同路径全量生成**，不引入 tool 式 `skipSchema` 按需模式：agent 数量级小
 * （十位数）且 Program 已复用，全量生成的边际成本可忽略；而「声明了 `Input` 但 zod.js
 * 缺失」若走按需生成，运行时无法区分「尚未生成」与「产物损坏」，schema 会静默退回
 * 单字段模式——全量生成让该场景只剩产物异常一种可能，`@faapi/agent` 侧对它显式抛错
 * （见 `@faapi/agent` 的 agent.md「派发入参 schema 声明」）。
 *
 * 与 [generateToolArtifacts](./generateToolArtifacts.md) 的差异：
 * - zod.js 仅对声明 `Input` 的 agent 生成（未声明保持单字段 `input` 交接单模式），
 *   dev/prod 一致全量（无 `skipSchema` 选项）
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
    });
    // 正常构建链路不该发生（createPrograms 按同一批 filePath 建 Program）——
    // 静默跳过会让 agent 从清单里无声消失
    if (!result) {
      throw new Error(
        `agent "${manifest.name}" 源文件不在 Program 中: ${manifest.filePath}——无法生成清单`,
      );
    }
    metadata.push(result);
  }

  // 2. 清单级校验：名重复 / agents 互引存在性
  validateAgentList(metadata);

  // 3. 序列化 + 写入 faapi-agents.js
  const serialized = serializeAgents(metadata, dist);
  const agentsPath = path.resolve(rootDir, dist, AGENTS_FILE);
  await writeAgentsModule(serialized, agentsPath);

  // 4. 声明 Input 的 agent 生成 zod.js（复用步骤 1 的 Program，零额外解析成本）
  await generateAgentZodArtifacts(metadata, programByFile, rootDir, dist);

  return metadata;
}

/**
 * 单个 agent 的 schema 提取结果（与 ToolSchemaSource / TaskSchemaSource 同构）
 */
interface AgentSchemaSource {
  /** agent 名（注释标识） */
  name: string;
  /** 源文件绝对路径（generateZodArtifacts 按文件分组生成 zod.js） */
  filePath: string;
  /** schema 名 = inputTypeName（导出 `${schemaName}Schema`，即 `InputSchema`） */
  schemaName: string;
  typeInfo: HandlerTypeInfo | null;
}

/**
 * 为声明 `inputTypeName` 的 agent 生成 zod.js（与 tool/task 共享同一 zod 产物管线）
 *
 * 类型提取复用元数据提取阶段已创建的 Program（programByFile）——同一批源文件
 * 二次 createPrograms 会全量重新解析，纯浪费。
 */
async function generateAgentZodArtifacts(
  metadata: AgentMetadata[],
  programByFile: ReturnType<typeof createPrograms>,
  rootDir: string,
  dist: string,
): Promise<void> {
  const declared = metadata.filter((a) => a.inputTypeName);
  if (declared.length === 0) return;

  const resolversByFile = new Map<string, LazyTypeResolver>();
  const sources: AgentSchemaSource[] = [];
  for (const agent of declared) {
    const absPath = path.resolve(rootDir, agent.filePath);
    const program = programByFile.get(absPath);
    if (!program) {
      // 步骤 1 已按同一批 filePath 建 Program——缺失说明内部状态不一致，显式失败
      throw new Error(
        `agent "${agent.name}" 源文件不在 Program 中: ${agent.filePath}——无法生成入参 schema`,
      );
    }
    if (!resolversByFile.has(absPath)) {
      resolversByFile.set(absPath, createLazyTypeResolver(program, absPath));
    }
    // inputTypeName 已在外层 filter 保证非空（防御性兜底同 tool 管线）
    const typeInfo = extractTypeInfo(program, absPath, agent.inputTypeName!);
    sources.push({
      name: agent.name,
      filePath: absPath,
      schemaName: agent.inputTypeName!,
      typeInfo,
    });
  }

  await generateZodArtifacts(sources, {
    generateFileSource: generateAgentSchemaFileSource,
    resolversByFile,
    rootDir,
    dist,
  });
}

/**
 * 生成单个 agent handler.ts 的 zod.js 源码（coerce=false——入参来自 LLM JSON 调用）
 *
 * 与 [generateTaskSchemaFileSource](./generateTaskArtifacts.md) 同构：导出格式
 * `${inputTypeName}Schema`（即 `InputSchema`），复用 [generateZodArtifacts](./generateZodArtifacts.md)
 * 共享管线，与 tool 的 zod.js 生成逻辑（generateToolSchemaFileSource）一致，仅注释
 * 标识不同（`// agent <name> → <schemaName>`）。
 */
function generateAgentSchemaFileSource(
  sources: AgentSchemaSource[],
  resolveType: (name: string) => RuntimeType | undefined,
  helpersImportPath: string,
): string {
  const lines: string[] = ["import { z } from 'zod';"];

  const schemaBlocks: string[] = [];
  for (const source of sources) {
    if (!source.typeInfo) continue;
    const block = [`// agent ${source.name} → ${source.schemaName}`];
    // agent schema coerce=false（入参来自 LLM JSON 调用,与 body/tool/task 一致）
    const schemaCode = generateZodSchemaSource(
      source.typeInfo,
      resolveType,
      source.schemaName,
      false,
    ).replace(/^import \{ z \} from 'zod';\s*\n\s*\n/, '');
    block.push(schemaCode);
    block.push('');
    schemaBlocks.push(block.join('\n'));
  }

  const allSchemaCode = schemaBlocks.join('\n');
  if (helpersImportPath && usesCoerceHelpers(allSchemaCode)) {
    lines.push(
      `import { coerceNumber, coerceBoolean, coerceMap, coerceSet } from '${helpersImportPath}';`,
    );
  }
  lines.push('');
  lines.push(...schemaBlocks);
  return lines.join('\n').replace(/\n+$/, '\n');
}
