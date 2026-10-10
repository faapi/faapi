import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { scanAgents, DEFAULT_AGENT_PATTERNS } from './agents/scanAgents';
import { scanTools, TOOL_PATTERNS } from './tools/scanTools';
import { generateAgentArtifacts } from './cli/generateAgentArtifacts';
import { generateToolArtifacts } from './cli/generateToolArtifacts';
import { serializeAgents, hydrateAgents } from './cli/generateAgentArtifacts';
import { serializeTools, hydrateTools } from './cli/generateToolArtifacts';
import { collectRelativeImports } from './cli/collectImports';
import { compileDevRoutes } from './cli/compileDevRoutes';
import {
  createToolRegistry,
  createAgentRegistry,
  type AppRegistries,
  type ToolRegistry,
  type AgentRegistry,
} from './injection/registries';
import { loadToolModule as loadToolModuleImpl } from './loader/loadToolModule';
import { createToolSchemaResolver, type ToolSchemaResolution } from './loader/toolSchemaResolver';
import type { ToolModule } from './loader/loadToolModule';
import type { ToolMetadata } from './ast/extractToolMetadata';
import type { AgentMetadata } from './ast/extractAgentMetadata';

/**
 * createAgentTestHarness 入参
 *
 * agent 流程测试设施：测试进程内扫描 agent/tool 源码 → AST 增强 → 水合出与生产
 * 同接口的注册表视图 + 可拼装 AgentDeps 的 loader 桥接。对位 HTTP 层的 createTestServer。
 * 详见 src/agentTestHarness.md。
 */
export interface AgentTestHarnessOptions {
  /** 项目根目录（agent/tool 源码所在，必填；目录不存在显式抛错） */
  rootDir: string;
  /**
   * 工具入参 schema 模式：
   * - `'free-form'`（默认）：放行为自由 schema——不生成 zod.js、不提供 schema 解析器
   *   （`Agent` 类对未接线的 deps 用自由 schema `{ type: 'object' }`），入参合法性由
   *   tool handler 自行校验。适合脚本假 LLM：脚本入参本就是用例给的
   * - `'generated'`：现场生成 zod.js（tool 入参 + 声明 `Input` 的 agent 派发入参）并
   *   按生产口径解析——流程测试同时覆盖「LLM 可见 schema + 派发/工具入参校验」这一层
   */
  schemaMode?: 'free-form' | 'generated';
  /** agent 扫描 glob，相对 rootDir；默认与 dev 启动一致（`DEFAULT_AGENT_PATTERNS`） */
  agentPatterns?: string[];
  /**
   * tool 扫描 glob，相对 rootDir；默认与 dev/build 一致（`TOOL_PATTERNS`）。
   * agent 本地 tools 项目显式传两层 patterns：`src/tools` 下全部 + `src/agents`
   * 下各 agent 的 tools 子目录（glob 形如 `src/agents/星号/tools/双星号.ts`）
   */
  toolPatterns?: string[];
  /**
   * 编译/schema 产物输出目录（绝对路径或相对 rootDir）。
   * 不传时自动 mkdtemp 生成临时目录，close() 时清理。
   */
  dist?: string;
}

/**
 * createAgentTestHarness 返回值
 *
 * 注册表视图 + loader 桥接与生产同接口，可直接拼进 `AgentDeps`；
 * `close()` 一行完成 teardown。详见 src/agentTestHarness.md。
 */
export interface AgentTestHarness {
  /**
   * 与生产同接口的注册表视图（实例级工厂创建后 hydrate，查询方法全量可用），
   * 可整体塞 `ctx.registries` 桩
   */
  registries: Pick<AppRegistries, 'agent' | 'tool'>;
  /**
   * 满足 `AgentDeps['loadToolModule']` 签名——registry 中的产物形式 `filePath`
   * 已在内部转绝对路径，业务方直接拼进 deps
   */
  loadToolModule: (filePath: string, functionName: string) => Promise<ToolModule>;
  /** 生产口径 schema 解析（仅 `schemaMode: 'generated'` 提供，free-form 为 undefined） */
  resolveToolSchema?: (tool: ToolMetadata) => Promise<ToolSchemaResolution | undefined>;
  /** 与 `resolveToolSchema` 同一实例（仅 `schemaMode: 'generated'` 提供） */
  resolveAgentInputSchema?: (agent: AgentMetadata) => Promise<ToolSchemaResolution | undefined>;
  /** 扫描水合后的 agent 注册名清单（`@agent` 覆盖名生效后） */
  agentNames: string[];
  /** 扫描水合后的 tool 最终名清单（`@tool` 覆盖名生效后） */
  toolNames: string[];
  /** 产物临时目录绝对路径（free-form 下含 tool handler 编译产物，generated 下另有 zod.js） */
  schemaDist: string;
  /**
   * 清理产物临时目录
   *
   * 幂等：重复调用不会重复清理。
   */
  close(): Promise<void>;
}

/**
 * 一键创建 agent 流程测试设施
 *
 * 内部流程：
 * 1. scanAgents / scanTools 扫描源码（零 import，与 dev 启动同管线）
 * 2. mkdtemp 临时产物目录（或用传入的 dist）
 * 3. generateAgentArtifacts / generateToolArtifacts（AST 增强 + 清单级校验；
 *    free-form 跳过 zod.js 生成）
 * 4. compileDevRoutes 编译 tool 源码及其 src 内依赖闭包（agent 源码不编译——
 *    声明式 agent 运行时不 import handler.js）
 * 5. 实例级注册表工厂 hydrate（不触全局注册表、不建 app——单进程单 app 零占用）
 * 6. 组装 loader 桥接（generated 时另接 schema 解析器，显式 dist 不触碰全局状态）
 *
 * 编译失败在创建时响亮抛错（带原始 cause）——构建期失败优于首次 tool 调用失败。
 *
 * 详见 src/agentTestHarness.md。
 *
 * @param options rootDir 必填，其余可选
 */
export async function createAgentTestHarness(
  options: AgentTestHarnessOptions,
): Promise<AgentTestHarness> {
  const {
    rootDir,
    schemaMode = 'free-form',
    agentPatterns = DEFAULT_AGENT_PATTERNS,
    toolPatterns = TOOL_PATTERNS,
    dist,
  } = options;

  // 0. rootDir 存在性校验（显式失败——静默扫描空清单会让测试跑在空注册表上）
  const rootStat = await fs.stat(rootDir).catch(() => null);
  if (!rootStat) {
    throw new Error(
      `createAgentTestHarness: rootDir does not exist: ${rootDir} — pass the project root that contains src/agents and src/tools`,
    );
  }
  if (!rootStat.isDirectory()) {
    throw new Error(`createAgentTestHarness: rootDir is not a directory: ${rootDir}`);
  }

  // 1. 扫描（零 import，与 dev 启动同管线：字符集校验 / 重名检测在此生效）
  const agents = await scanAgents(rootDir, agentPatterns);
  const tools = await scanTools(rootDir, toolPatterns);

  // 2. 临时产物目录（未传 dist 时自动 mkdtemp）
  const schemaDist = dist
    ? path.isAbsolute(dist)
      ? dist
      : path.resolve(rootDir, dist)
    : await fs.mkdtemp(path.join(os.tmpdir(), 'faapi-agent-harness-'));

  // 3. AST 增强 + 清单产物（free-form 跳过 zod.js——不提供 schema 解析器时产物不会被读取）
  const skipSchema = schemaMode !== 'generated';
  const agentMetadata = await generateAgentArtifacts(agents, rootDir, schemaDist, { skipSchema });
  const toolMetadata = await generateToolArtifacts(tools, rootDir, schemaDist, { skipSchema });

  // 4. 编译 tool 源码及其 src 内依赖闭包（自封性：测试进程不要求先跑过 build）
  //    agent 源码不编译——声明式 agent 运行时不 import handler.js（人设走 systemPromptFile
  //    的 readResource 直读，入参 schema 走 AST 管线的 zod.js）
  if (tools.length > 0) {
    const toolAbsPaths = tools.map((m) => path.resolve(rootDir, m.filePath));
    const { insideFiles } = await collectRelativeImports(toolAbsPaths, rootDir);
    try {
      await compileDevRoutes({
        rootDir,
        dist: schemaDist,
        files: [...toolAbsPaths, ...insideFiles],
        logLevel: 'silent',
      });
    } catch (err) {
      await fs.rm(schemaDist, { recursive: true, force: true }).catch(() => {});
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `createAgentTestHarness: failed to compile tool sources under ${rootDir}: ${reason}`,
        { cause: err },
      );
    }
  }

  // 5. 实例级注册表水合（与生产同接口：createAppBase 同款工厂，互不串台）。
  //    走 serialize→hydrate 往返与生产水合形态一致——registry 中的 filePath 为
  //    产物形式（临时目录前缀），直接 hydrate AST 返回值会让 filePath 停在源码形式
  const toolRegistry: ToolRegistry = createToolRegistry();
  toolRegistry.hydrate(hydrateTools(serializeTools(toolMetadata, schemaDist)));
  const agentRegistry: AgentRegistry = createAgentRegistry(toolRegistry);
  agentRegistry.hydrate(hydrateAgents(serializeAgents(agentMetadata, schemaDist)));

  // 6. loader 桥接：registry 中的产物形式 filePath（临时目录前缀）转绝对路径后走
  //    生产 loadToolModule（vitest 下经 importWithCacheBust 走 Vite SSR pipeline——
  //    tsconfig paths 别名与 vi.mock 与 createTestServer 同行为）
  const bridgeLoadToolModule = async (
    filePath: string,
    functionName: string,
  ): Promise<ToolModule> => {
    const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(rootDir, filePath);
    return loadToolModuleImpl(absPath, functionName, rootDir);
  };

  // schema 解析器（仅 generated）：显式 dist 指向临时产物目录——不读 dev on demand /
  // FAAPI_DIST 全局状态，与同进程的生产路径互不干扰
  const resolveSchema =
    schemaMode === 'generated'
      ? createToolSchemaResolver({ rootDir, dist: schemaDist })
      : undefined;

  let closed = false;

  const harness: AgentTestHarness = {
    registries: { agent: agentRegistry, tool: toolRegistry },
    loadToolModule: bridgeLoadToolModule,
    ...(resolveSchema
      ? { resolveToolSchema: resolveSchema, resolveAgentInputSchema: resolveSchema }
      : {}),
    agentNames: agentRegistry.listAgents().map((a) => a.name),
    toolNames: toolRegistry.list().map((t) => t.name),
    schemaDist,

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      // 清理失败不阻塞 close 流程：closed 标记已设，目录可能在 OS 临时目录被外部清理
      await fs.rm(schemaDist, { recursive: true, force: true }).catch(() => {});
    },
  };

  return harness;
}
