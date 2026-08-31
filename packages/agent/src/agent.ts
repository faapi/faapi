import type {
  AgentCore,
  AgentMetadata,
  AgentModule,
  AgentToolDescriptor,
  LlmConfig,
  ToolMetadata,
  ToolModule,
} from '@faapi/faapi';
import type { AgentRunOptions } from './agentHandle';
import type { LLMProvider, LLMToolDefinition } from './provider';
import {
  reactLoop,
  reactLoopStream,
  type ReactLoopConfig,
  type ReactLoopResult,
  type ReactLoopStreamChunk,
} from './reactLoop';
import type { TracingToolResult } from './trace';

/**
 * Agent 类——按 `agent.name` 查找元数据、组装 tool 列表、提供 `run` / `stream` / `asTool`
 *
 * 把 [reactLoop](./reactLoop.md) 与 faapi 核心的 agent/tool 注册表粘合起来：
 * - **组装 tool 列表**——合并 `resolveAgentTools`（agent 显式声明的 `tools`）+ sub-agent
 * - **执行 tool**——`reactLoop` 调 `executeTool(name, args)` 时，Agent 路由：
 *   - 常规 tool → `loadToolModule` 加载 handler + 可选 input 校验 → 调用
 *   - `agent.` 前缀 → 递归构造 sub-agent 调用（含 `maxAgentDepth` 防护）
 * - **递归防护**——`maxAgentDepth` 限制 agent 调用 agent 的深度
 * - **自定义 run**——agent handler 导出 `run` 函数时，sub-agent 走自定义逻辑
 *
 * 详见 [agent.md](./agent.md)。
 */

/** 默认最大 agent 递归深度（根 agent depth=1，sub-agent 递增） */
const DEFAULT_MAX_AGENT_DEPTH = 3;

/**
 * 全局 agent 配置覆盖
 *
 * 来自 faapi.config.ts 的 `agent` 块，提供全局默认值。
 * agent 自身 `config.maxTurns` / `config.model` 优先于全局配置。
 */
export interface AgentRuntimeConfig {
  /** 默认最大对话轮数（agent 自身 maxTurns 优先） */
  maxTurns?: number;
  /** agent 调用 agent 的最大递归深度（默认 3） */
  maxAgentDepth?: number;
  /**
   * 启用 tracing 的全局默认值（默认 true）。
   *
   * 开启时 `ReactLoopResult.trace` / `ReactLoopStreamChunk.traceEvent` 填充
   * 结构化调用明细,详见 [trace.md](./trace.md)。
   *
   * 单次调用可通过 `AgentRunOptions.enableTracing` 覆盖。
   * 业务方在生产主路径显式设 `false` 关闭以零开销运行。
   */
  enableTracing?: boolean;
}

/**
 * tool schema 解析结果
 *
 * 由 Phase 3.5 的注入器实现，提供 JSON Schema（给 LLM）和校验函数（给执行前校验）。
 * - `jsonSchema` —— 发给 LLM 作为 tool 参数描述
 * - `validate` —— 执行前校验 LLM 返回的参数，失败时返回 `{ error }` 回传 LLM 重试
 */
export interface ToolSchemaResolution {
  /** tool 参数的 JSON Schema（发给 LLM） */
  jsonSchema: Record<string, unknown>;
  /** 执行前校验函数（成功返回 coerce 后的 value，失败返回 error） */
  validate: (
    input: Record<string, unknown>,
  ) => { ok: true; value: Record<string, unknown> } | { ok: false; error: string };
}

/**
 * Agent 运行时依赖（依赖注入）
 *
 * Agent 类**不直接 import** faapi 核心的注册表/加载器，而是通过此接口接收访问器函数。
 * 原因：
 * - **可测试**——测试传 mock 访问器，无需启动真实注册表
 * - **解耦**——Agent 类不依赖核心运行时模块
 * - **phase 边界**——Phase 3.4 实现 Agent 类逻辑，Phase 3.5 注入真实访问器
 *
 * 访问器签名与 faapi 核心对称（见 [agent.md](./agent.md) 依赖注入章节）。
 */
export interface AgentDeps {
  /** LLM provider 实例映射（key 是 provider 名，来自 config.agent.llms） */
  providers: Map<string, LLMProvider>;
  /** 默认 provider 实例（config.agent.defaultLlm 对应，或 llms 第一个 key） */
  defaultProvider: LLMProvider;
  /** LLM provider 配置映射（含 models，用于 options.model key 解析） */
  llms: Record<string, LlmConfig>;
  /** 默认 provider key（config.agent.defaultLlm，或 llms 第一个 key） */
  defaultLlm: string;
  /** 当前 agent 名 */
  agentName: string;
  /** 项目根目录（Phase 3.5 接线时用于加载器） */
  rootDir: string;
  /** 全局 agent 配置覆盖 */
  config?: AgentRuntimeConfig;
  /** 查 agent LLM 可见元数据（对应 agentRegistry.getAgent,返回 AgentCore） */
  getAgent: (name: string) => AgentCore | undefined;
  /** 查 agent 完整元数据（对应 agentRegistry.getAgentEntry,返回 AgentMetadata 含 filePath/hasRun） */
  getAgentEntry: (name: string) => AgentMetadata | undefined;
  /** 查 tool 元数据（对应 toolRegistry.getTool） */
  getTool: (name: string) => ToolMetadata | undefined;
  /** 解析 agent 可用常规 tool（对应 agentRegistry.resolveAgentTools） */
  resolveAgentTools: (name: string) => ToolMetadata[];
  /** 解析 agent 可调用 sub-agent 列表（对应 agentRegistry.resolveSubAgents,返回 AgentCore[]） */
  resolveSubAgents: (name: string) => AgentCore[];
  /** 动态 import tool handler（对应 loadToolModule） */
  loadToolModule: (filePath: string, functionName: string) => Promise<ToolModule>;
  /** 动态 import agent handler（对应 loadAgentModule,仅 hasRun 参数,无 hasConfig） */
  loadAgentModule: (filePath: string, hasRun: boolean) => Promise<AgentModule>;
  /** tool input 的 schema 解析（Phase 3.5 实现，可选） */
  resolveToolSchema?: (tool: ToolMetadata) => Promise<ToolSchemaResolution | undefined>;
}

/**
 * Agent 系统级错误
 *
 * agent 未注册等不可恢复错误时抛出（调用方负责捕获）。
 * sub-agent 递归超限用 {@link AgentRecursionError}。
 */
export class AgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentError';
  }
}

/**
 * sub-agent 递归超 `maxAgentDepth` 时抛出
 *
 * 被 [reactLoop](./reactLoop.md) catch 后错误消息回传 LLM，LLM 可据此调整策略。
 */
export class AgentRecursionError extends AgentError {
  /** 配置的 maxAgentDepth 值 */
  readonly maxDepth: number;
  /** 当前递归深度（超出 maxDepth） */
  readonly currentDepth: number;

  constructor(maxDepth: number, currentDepth: number) {
    super(
      `Agent recursion depth exceeded: current depth ${currentDepth} > maxAgentDepth ${maxDepth}`,
    );
    this.name = 'AgentRecursionError';
    this.maxDepth = maxDepth;
    this.currentDepth = currentDepth;
  }
}

/**
 * faapi Agent
 *
 * 组装 [reactLoop](./reactLoop.md) 配置、执行 tool、递归 sub-agent 的运行时入口。
 */
export class Agent {
  private readonly deps: AgentDeps;
  /** 当前递归深度（根 agent 为 1，sub-agent 递增） */
  private readonly depth: number;
  /**
   * tool schema 解析缓存（按 tool.name 缓存，含 undefined 结果）
   *
   * `buildToolDefinitions` 组装 LLM tool 列表时解析一次 schema（取 jsonSchema），
   * `executeTool` 执行前校验时复用同一份 schema（取 validate）——
   * 避免每次 tool 执行都重新 `loadToolSchema` + `z.toJSONSchema`。
   *
   * 实例级缓存：sub-agent 各有独立 cache（tool 集合可能不同）。
   */
  private readonly schemaCache = new Map<string, ToolSchemaResolution | undefined>();

  /**
   * @param deps 运行时依赖（访问器 + providers Map + defaultProvider + llms + config）
   * @param depth 递归深度（默认 1 = 根 agent；sub-agent 递归时传入 depth+1）
   */
  constructor(deps: AgentDeps, depth: number = 1) {
    this.deps = deps;
    this.depth = depth;
  }

  /**
   * 非流式执行——组装 config 调 [reactLoop](./reactLoop.md)
   *
   * reactLoop 不知 agent 名（只关心循环逻辑）,返回的 `result.trace.agentName` 为空字符串。
   * 本方法在 reactLoop 返回后填充 `this.deps.agentName`,让顶层 trace 标识"是哪个 agent 跑的"。
   *
   * @param input 用户输入
   * @param options 临时覆盖本次调用的 model（字符串 key）/ temperature / maxTokens / enableTracing
   *                （不修改 agent 自身状态,详见 [agentHandle](./agentHandle.md)）
   * @returns 最终结果（content + messages + turns + stopReason + usage + trace?）
   * @throws {AgentError} agent 未注册
   * @throws {ReactLoopError} 超出 maxTurns
   * @throws {Error} provider.complete 抛错时立即传播
   */
  async run(input: string, options?: AgentRunOptions): Promise<ReactLoopResult> {
    const config = await this.buildLoopConfig(options);
    const result = await reactLoop(input, config);
    // reactLoop 不知 agent 名,在此填充顶层 trace.agentName（sub-agent 调本方法时也走此路径）
    if (result.trace) {
      result.trace.agentName = this.deps.agentName;
    }
    return result;
  }

  /**
   * 流式执行——组装 config 调 [reactLoopStream](./reactLoop.md)
   *
   * @param input 用户输入
   * @param options 临时覆盖本次调用的 model（字符串 key）/ temperature / maxTokens
   *                （不修改 agent 自身状态,详见 [agentHandle](./agentHandle.md)）
   * @yields 流式 chunk（deltaContent / toolCall / toolResult / done）
   * @throws {AgentError} agent 未注册
   * @throws {ReactLoopError} 超出 maxTurns
   * @throws {Error} provider.stream 抛错时立即传播
   */
  async *stream(input: string, options?: AgentRunOptions): AsyncIterable<ReactLoopStreamChunk> {
    const config = await this.buildLoopConfig(options);
    yield* reactLoopStream(input, config);
  }

  /**
   * 把自身包装为 `AgentToolDescriptor` 供 LLM 当 tool 调用
   *
   * 与 [agentRegistry.asTool](../../faapi/src/injection/agentRegistry.md) 同构——
   * Agent 类自带此方法便于在注入器场景直接调用（不必再过注册表）。
   *
   * @returns `AgentToolDescriptor` 或 `undefined`（agent 未注册）
   */
  asTool(): AgentToolDescriptor | undefined {
    const meta = this.deps.getAgent(this.deps.agentName);
    if (!meta) return undefined;
    return {
      kind: 'agent',
      name: `agent.${meta.name}`,
      agentName: meta.name,
      description: meta.description,
      metadata: meta,
    };
  }

  // ─── 内部方法 ────────────────────────────────────────

  /**
   * 查询 tool schema（带缓存）
   *
   * `buildToolDefinitions` 与 `executeTool` 共用此方法——
   * 首次调用触发 `deps.resolveToolSchema`（加载 zod.js + 生成 JSON Schema），
   * 后续命中缓存直接返回（含 `undefined` 结果，用 `has` 区分未解析 vs 解析为空）。
   *
   * `deps.resolveToolSchema` 未提供时直接返回 `undefined`，不写缓存。
   */
  private async getToolSchema(tool: ToolMetadata): Promise<ToolSchemaResolution | undefined> {
    if (!this.deps.resolveToolSchema) return undefined;
    if (this.schemaCache.has(tool.name)) {
      return this.schemaCache.get(tool.name);
    }
    const resolved = await this.deps.resolveToolSchema(tool);
    this.schemaCache.set(tool.name, resolved);
    return resolved;
  }

  /**
   * 组装 ReactLoopConfig
   *
   * 1. 查 agent 元数据（未注册抛 AgentError）——用 `getAgent` 拿 AgentCore
   *    (LLM-facing 字段:systemPrompt / model / maxTurns)
   * 2. buildToolDefinitions 组装 tool 列表
   * 3. config 字段优先级（高 → 低）：`options` > agent 元数据 > 全局 AgentRuntimeConfig / deps.defaultProvider
   *
   * `options.model` 是字符串 key,由 {@link resolveModelKey} 解析为 provider + model
   * （支持 llms key 精确匹配 / `provider/model` 一体化 / 纯 model 名模糊匹配）。
   * 不传 `options.model` 时用 `deps.defaultProvider` + agent 元数据 `config.model`。
   * 详见 [agentHandle.md](./agentHandle.md) 的「`options.model` 字符串 key 解析规则」。
   */
  private async buildLoopConfig(options?: AgentRunOptions): Promise<ReactLoopConfig> {
    const meta = this.deps.getAgent(this.deps.agentName);
    if (!meta) {
      throw new AgentError(`Agent "${this.deps.agentName}" is not registered`);
    }

    const tools = await this.buildToolDefinitions();

    // 解析 options.model 字符串 key → provider + model
    const { provider, model } = this.resolveModelKey(options?.model, meta);

    // enableTracing 优先级:options > deps.config > 默认 true
    // 闭包捕获 enableTracing,通过 executeTool 传递给 executeSubAgent,使其能包装 TracingToolResult
    const enableTracing = options?.enableTracing ?? this.deps.config?.enableTracing ?? true;

    return {
      provider,
      systemPrompt: meta.systemPrompt,
      model,
      temperature: options?.temperature,
      maxTokens: options?.maxTokens,
      maxTurns: meta.maxTurns ?? this.deps.config?.maxTurns,
      tools,
      enableTracing,
      executeTool: async (name, args) => this.executeTool(name, args, enableTracing),
    };
  }

  /**
   * 解析 `options.model` 字符串 key → provider + model
   *
   * 规则见 [agentHandle.md](./agentHandle.md) 的「`options.model` 字符串 key 解析规则」：
   * 1. `undefined` → `deps.defaultProvider` + `meta.model`
   * 2. 精确匹配 `deps.providers` 的 key → 该 provider + 其 `models` 第一个 key
   * 3. 含 `/` → `provider/model` 形式,`deps.providers.get(provider)` + 该 model
   *    （要求该 model 在 `deps.llms[provider].models` 里）
   * 4. 不含 `/` 且非 provider key → 在所有 provider 的 `models` 里按 model 名查找
   *    - 唯一 → 该 provider + 该 model
   *    - 多个 → 抛 `AgentError`（要求用 `provider/model` 消歧）
   *    - 无 → 抛 `AgentError`
   *
   * @throws {AgentError} key 解析失败（provider/model 不存在或歧义）
   */
  private resolveModelKey(
    key: string | undefined,
    meta: AgentCore,
  ): { provider: LLMProvider; model: string | undefined } {
    // 不传 → 默认 provider + agent 元数据 model
    if (key === undefined) {
      return { provider: this.deps.defaultProvider, model: meta.model };
    }

    // 规则 1：精确匹配 providers key（如 'openai'）
    const byProviderKey = this.deps.providers.get(key);
    if (byProviderKey) {
      const llmConfig = this.deps.llms[key];
      const firstModel = llmConfig ? Object.keys(llmConfig.models)[0] : undefined;
      return { provider: byProviderKey, model: firstModel ?? meta.model };
    }

    // 规则 2：含 '/' → provider/model 形式（如 'openai/gpt-4o'）
    if (key.includes('/')) {
      const slashIdx = key.indexOf('/');
      const providerName = key.slice(0, slashIdx);
      const modelName = key.slice(slashIdx + 1);
      const provider = this.deps.providers.get(providerName);
      if (!provider) {
        throw new AgentError(`Unknown provider "${providerName}" in model key "${key}"`);
      }
      const llmConfig = this.deps.llms[providerName];
      if (!llmConfig || !llmConfig.models[modelName]) {
        throw new AgentError(
          `Model "${modelName}" not found in provider "${providerName}". Declare it in config.agent.llms.${providerName}.models.`,
        );
      }
      return { provider, model: modelName };
    }

    // 规则 3：纯 model 名模糊匹配（如 'gpt-4o'）
    const matches: { provider: LLMProvider; providerName: string }[] = [];
    for (const [providerName, provider] of this.deps.providers) {
      const llmConfig = this.deps.llms[providerName];
      if (llmConfig && llmConfig.models[key]) {
        matches.push({ provider, providerName });
      }
    }
    if (matches.length === 1) {
      return { provider: matches[0].provider, model: key };
    }
    if (matches.length > 1) {
      throw new AgentError(
        `Model "${key}" is ambiguous (found in providers: ${matches.map((m) => m.providerName).join(', ')}). Use "provider/model" to disambiguate.`,
      );
    }
    throw new AgentError(
      `Model "${key}" not found in any provider. Declare it in config.agent.llms.*.models.`,
    );
  }

  /**
   * 组装 LLM 可见 tool 列表
   *
   * 合并两个来源（按 `name` 去重，先入者保留）：
   * 1. **resolveAgentTools** —— agent 显式声明的 `tools` 引用
   * 2. **sub-agent** —— `resolveSubAgents` 每个包装为 `agent.<name>`
   *
   * 每个常规 tool 的 `input`：
   * - `resolveToolSchema` 提供 → 用其 `jsonSchema`
   * - 未提供 / tool 无 `inputTypeName` → 自由 schema `{ type: 'object' }`
   *
   * sub-agent 的 `input` 始终为 `{ type: 'object' }`（agent 参数开放）。
   */
  private async buildToolDefinitions(): Promise<LLMToolDefinition[]> {
    const definitions = new Map<string, LLMToolDefinition>();

    // 1. resolveAgentTools（agent 显式声明的 tools 引用）
    for (const tool of this.deps.resolveAgentTools(this.deps.agentName)) {
      if (definitions.has(tool.name)) continue;
      const schemaRes = await this.getToolSchema(tool);
      definitions.set(tool.name, {
        name: tool.name,
        description: tool.description,
        input: schemaRes?.jsonSchema ?? { type: 'object' },
      });
    }

    // 2. sub-agent（包装为 agent.<name>）
    for (const subAgent of this.deps.resolveSubAgents(this.deps.agentName)) {
      const name = `agent.${subAgent.name}`;
      if (definitions.has(name)) continue;
      definitions.set(name, {
        name,
        description: subAgent.description,
        input: { type: 'object' },
      });
    }

    return Array.from(definitions.values());
  }

  /**
   * tool 执行路由（由 reactLoop 调用）
   *
   * - `agent.` 前缀 → {@link executeSubAgent} 递归（含 enableTracing + TracingToolResult 包装）
   * - 常规 tool → `loadToolModule` 加载 handler + 可选 input 校验 → 调用
   *
   * `enableTracing` 由 [buildLoopConfig](#buildLoopConfig) 闭包捕获传入,用于 sub-agent
   * 调用时决定是否包装 [TracingToolResult](./trace.md) 携带 sub-trace。
   *
   * **常规 tool 校验失败**：不抛错，返回 `{ error }` 对象——reactLoop stringify 后
   * 作为 tool 结果回传 LLM，LLM 可据此修正参数重试。
   *
   * **tool 未找到 / 加载失败**：抛错，被 reactLoop catch 后同样回传 LLM。
   */
  private async executeTool(
    name: string,
    args: Record<string, unknown>,
    enableTracing: boolean,
  ): Promise<unknown | TracingToolResult> {
    // sub-agent 递归（携带 enableTracing,使其能包装 TracingToolResult）
    if (name.startsWith('agent.')) {
      return this.executeSubAgent(name.slice(6), args, enableTracing);
    }

    // 常规 tool
    const tool = this.deps.getTool(name);
    if (!tool) {
      throw new Error(`Tool "${name}" not found`);
    }

    // 可选 input 校验
    const schemaRes = await this.getToolSchema(tool);
    let callArgs = args;
    if (schemaRes) {
      const result = schemaRes.validate(args);
      if (!result.ok) {
        // 校验失败：返回 { error } 对象，不调用 handler——错误回传 LLM 重试
        return { error: result.error };
      }
      callArgs = result.value ?? args;
    }

    const mod = await this.deps.loadToolModule(tool.filePath, tool.functionName);
    return await mod.handler(callArgs);
  }

  /**
   * sub-agent 递归执行
   *
   * 1. `maxAgentDepth` 防护——超限抛 {@link AgentRecursionError}
   * 2. sub-agent handler 导出 `run` 时调自定义 `mod.run(args)`（无 trace,与常规 tool 一致）
   * 3. 无 `run` 时调 `subAgent.run(stringify(args), { enableTracing })` 走默认 reactLoop
   *
   * **tracing 路径**：`enableTracing=true` 时,subAgent.run 返回的 `result.trace`（agentName
   * 已被 `Agent.run` 填为 subName）被包装为 [TracingToolResult](./trace.md) 返回给 reactLoop。
   * reactLoop 通过 `isTracingToolResult` 识别后发出 `subagent_call` 事件,嵌入 sub-trace
   * （递归结构,业务方可还原完整调用树）。`enableTracing=false` 时返回 `result.content`
   * （unknown,与常规 tool 一致,零开销）。
   *
   * **自定义 run 无 trace**：业务方导出 `run` 函数时直接返回业务结果,无法采集 sub-agent
   * 内部明细——需 trace 时应让 sub-agent 走默认 reactLoop（不导出 `run`）。
   *
   * 自定义 run 接收原始 args 对象；默认 reactLoop 接收 stringify 后的 args
   * 作为 user 消息（agent-as-tool input 为开放式 JSON）。
   *
   * 加载 handler.js 用 `getAgentEntry`(返回 AgentMetadata,含 filePath/hasRun),
   * 而非 `getAgent`(返回 AgentCore,无代码加载细节)。DB skill 无文件,
   * `getAgentEntry` 返回 `undefined`,走默认 reactLoop。
   */
  private async executeSubAgent(
    subName: string,
    args: Record<string, unknown>,
    enableTracing: boolean,
  ): Promise<unknown | TracingToolResult> {
    const newDepth = this.depth + 1;
    const maxDepth = this.deps.config?.maxAgentDepth ?? DEFAULT_MAX_AGENT_DEPTH;
    if (newDepth > maxDepth) {
      throw new AgentRecursionError(maxDepth, newDepth);
    }

    // 构造子 agent（复用父 deps，仅覆盖 agentName）
    const subDeps: AgentDeps = { ...this.deps, agentName: subName };
    const subAgent = new Agent(subDeps, newDepth);

    // 自定义 run：sub-agent handler 导出 run 函数时走自定义逻辑（无 trace）
    // 用 getAgentEntry 拿 AgentMetadata(含 filePath/hasRun),DB skill 无文件走默认 reactLoop
    const entry = this.deps.getAgentEntry(subName);
    if (entry?.hasRun) {
      const mod = await this.deps.loadAgentModule(entry.filePath, entry.hasRun);
      if (mod.run) {
        return await mod.run(args);
      }
    }

    // 默认 reactLoop：stringify args 作为 user 消息,传递 enableTracing 让 sub-agent 采集 trace
    const result = await subAgent.run(typeof args === 'string' ? args : JSON.stringify(args), {
      enableTracing,
    });

    // enableTracing=true:包装 TracingToolResult,reactLoop 据此发出 subagent_call 事件
    // enableTracing=false:直接返回 content（unknown,与常规 tool 一致,零开销）
    if (enableTracing && result.trace) {
      return {
        __trace: true,
        result: result.content,
        trace: result.trace,
      } satisfies TracingToolResult;
    }
    return result.content;
  }
}
