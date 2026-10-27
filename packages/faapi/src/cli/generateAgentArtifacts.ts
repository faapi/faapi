import fs from 'node:fs';
import path from 'node:path';
import type { AgentManifestList } from '../agents/agentTypes';
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
 * 序列化的 agent 定位清单记录（可写入 JS 模块，纯静态事实）
 *
 * agent 声明运行时化重构后，清单降级为**定位清单**——只携带扫描期可定的静态事实
 * （agent 名、handler 产物路径、Input 类型导出检测），config 块字段由运行时
 * 启动期动态 import handler 模块求值（见 [loadAgents](../agents/loadAgents.md)）。
 *
 * `inputTypeName` 必须由清单携带：TS 类型编译期擦除，运行时无法从 handler.js
 * 反射「是否声明了 Input」——它是 `@faapi/agent` sub-agent 富 schema 派发的
 * 运行时判据。prod 运行时只有 dist 产物、无法重扫 src，清单因此保留（与
 * faapi-routes.js / faapi-tools.js 同构：只携带扫描期事实，不含声明数据）。
 */
export interface SerializedAgentRecord {
  /** agent 名（目录路径推导值，嵌套段用 `_` 连接） */
  name: string;
  /** 产物形式路径（如 `dist/agents/researcher/handler.js`），启动期动态 import 定位用 */
  filePath: string;
  /** 派发入参 schema 声明（handler.ts 顶层 Input 导出检测），无则省略 */
  inputTypeName?: string;
}

/**
 * Input 类型导出的正则检测
 *
 * 匹配 handler.ts 顶层 `export interface Input` / `interface Input` /
 * `export type Input` / `type Input`（行首锚定 + 词边界，与 tool 的函数名正则
 * 提取同款零 AST 预过滤策略）。命中者才建 TS Program 提取类型生成 zod.js——
 * 零 Input 的项目不付 AST 成本。
 */
const INPUT_DECLARATION_PATTERN = /^\s*(?:export\s+)?(?:interface|type)\s+Input\b/m;

/**
 * faapi-agents.js 文件名（与 faapi-routes.js / faapi-tools.js 同构）
 */
const AGENTS_FILE = 'faapi-agents.js';

/**
 * 把定位清单写入 faapi-agents.js
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
 * 主入口：从 AgentManifest[] 生成定位清单 faapi-agents.js + 声明 `Input` 的 agent zod.js
 *
 * agent 声明运行时化后的瘦身管线（清单仅做定位，config 块在运行时启动期
 * 动态 import handler 模块求值，见 [loadAgents](../agents/loadAgents.md)）。内部流程：
 *
 * 1. 正则检测每个 handler.ts 是否声明顶层 `Input` 类型导出（零 AST 预过滤）
 * 2. 命中者建 TS Program + `extractTypeInfo` → `generateZodArtifacts` 生成
 *    `<dist>/agents/<name>/zod.js`（导出 `InputSchema`，coerce=false——入参来自
 *    LLM JSON 调用，与 tool/task 同语义）
 * 3. 序列化定位记录（filePath 转产物形式）+ 写入 `<dist>/faapi-agents.js`
 *
 * **zod.js 生成与 tool/task 复用同一共享管线**（[generateZodArtifacts](./generateZodArtifacts.md)）。
 * Input 检测属于类型→zod 通用 schema 域（与 tool 第一参类型提取同构）——`inputTypeName`
 * 是 `@faapi/agent` 富 schema 派发的运行时判据，删除即静默降级为自由文本交接单。
 *
 * **dev/prod 同路径全量生成**，不引入 tool 式按需生成：agent 数量级小
 * （十位数）且 Program 仅对命中 Input 的文件创建，全量生成的边际成本可忽略；
 * 而「声明了 `Input` 但 zod.js 缺失」若走按需生成，运行时无法区分「尚未生成」
 * 与「产物损坏」，schema 会静默退回单字段模式——全量生成让该场景只剩产物异常
 * 一种可能，`@faapi/agent` 侧对它显式抛错（见 `@faapi/agent` 的 agent.md
 * 「派发入参 schema 声明」）。
 *
 * `options.skipSchema`（可选，默认 false）：跳过 zod.js 生成，仅供不入产物的测试设施
 * （`createAgentTestHarness` 的 `free-form` 模式）使用——该模式不提供 schema 解析器，
 * 生成的 zod.js 不会被任何路径读取，生成纯属浪费。dev/build 管线不传此选项（语义：
 * 声明了 `Input` 即必须有产物，「跳过生成」在产物流水线上是静默降级）。
 *
 * 与 [generateToolArtifacts](./generateToolArtifacts.md) 的差异：
 * - zod.js 仅对声明 `Input` 的 agent 生成（未声明保持单字段 `input` 交接单模式）
 * - 文件名常量为 `faapi-agents.js`，导出 `agents` 而非 `tools`
 *
 * @param agents scanAgents 产出的 AgentManifest[]（仅定位字段）
 * @param rootDir 项目根目录
 * @param dist 产物目录（`.faapi` 或 `dist`）
 * @param options.skipSchema 跳过 zod.js 生成（仅测试设施 free-form 模式使用）
 * @returns 定位清单记录（供调用方日志/调试）
 */
export async function generateAgentArtifacts(
  agents: AgentManifestList,
  rootDir: string,
  dist: string,
  options?: { skipSchema?: boolean },
): Promise<SerializedAgentRecord[]> {
  // 1. Input 类型导出正则检测（零 AST 预过滤——仅命中者建 Program）
  const inputDetected: { name: string; absPath: string }[] = [];
  for (const manifest of agents) {
    const absPath = path.resolve(rootDir, manifest.filePath);
    const source = fs.readFileSync(absPath, 'utf-8');
    if (INPUT_DECLARATION_PATTERN.test(source)) {
      inputDetected.push({ name: manifest.name, absPath });
    }
  }

  // 2. 命中 Input 的 agent 生成 zod.js（共享管线；skipSchema 仅测试设施 free-form 模式）
  if (!options?.skipSchema && inputDetected.length > 0) {
    const programByFile = createPrograms(inputDetected.map((d) => d.absPath));
    const resolversByFile = new Map<string, LazyTypeResolver>();
    const sources: AgentSchemaSource[] = [];
    for (const detected of inputDetected) {
      const program = programByFile.get(detected.absPath);
      if (!program) {
        // 上一步按同一批 absPath 建 Program——缺失说明内部状态不一致，显式失败
        throw new Error(
          `agent "${detected.name}" 源文件不在 Program 中: ${detected.absPath}——无法生成入参 schema`,
        );
      }
      if (!resolversByFile.has(detected.absPath)) {
        resolversByFile.set(detected.absPath, createLazyTypeResolver(program, detected.absPath));
      }
      // Input 声明已由正则预过滤保证存在；类型提取失败（不合法类型引用）由
      // extractTypeInfo 内部抛 SchemaExtractionError——与 tool 管线同语义
      const typeInfo = extractTypeInfo(program, detected.absPath, 'Input');
      sources.push({
        name: detected.name,
        filePath: detected.absPath,
        schemaName: 'Input',
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

  // 3. 序列化定位清单 + 写入 faapi-agents.js
  const serialized: SerializedAgentRecord[] = agents.map((a) => ({
    name: a.name,
    filePath: toProdFilePath(a.filePath, dist),
    ...(inputDetected.some((d) => d.name === a.name) ? { inputTypeName: 'Input' } : {}),
  }));
  const agentsPath = path.resolve(rootDir, dist, AGENTS_FILE);
  await writeAgentsModule(serialized, agentsPath);

  return serialized;
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
