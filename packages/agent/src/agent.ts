import type {
  AgentMetadata,
  AgentModule,
  AgentToolDescriptor,
  ToolMetadata,
  ToolModule,
} from '@faapi/faapi';
import type { LLMProvider, LLMToolDefinition } from './provider';
import {
  reactLoop,
  reactLoopStream,
  type ReactLoopConfig,
  type ReactLoopResult,
  type ReactLoopStreamChunk,
} from './reactLoop';

/**
 * Agent 类——按 `agent.name` 查找元数据、组装 tool 列表、提供 `run` / `stream` / `asTool`
 *
 * 把 [reactLoop](./reactLoop.md) 与 faapi 核心的 agent/tool 注册表粘合起来：
 * - **组装 tool 列表**——合并 `resolveAgentTools`（agent 显式声明的 `tools`）+ `defaultTools` + sub-agent
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
  /** 默认 tool 列表，所有 agent 都可用 */
  defaultTools?: string[];
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
  /** LLM provider 实例 */
  provider: LLMProvider;
  /** 当前 agent 名 */
  agentName: string;
  /** 项目根目录（Phase 3.5 接线时用于加载器） */
  rootDir: string;
  /** 全局 agent 配置覆盖 */
  config?: AgentRuntimeConfig;
  /** 查 agent 元数据（对应 agentRegistry.getAgent） */
  getAgent: (name: string) => AgentMetadata | undefined;
  /** 查 tool 元数据（对应 toolRegistry.getTool） */
  getTool: (name: string) => ToolMetadata | undefined;
  /** 解析 agent 可用常规 tool（对应 agentRegistry.resolveAgentTools） */
  resolveAgentTools: (name: string) => ToolMetadata[];
  /** 解析 agent 可调用 sub-agent 列表（对应 agentRegistry.resolveSubAgents） */
  resolveSubAgents: (name: string) => AgentMetadata[];
  /** 动态 import tool handler（对应 loadToolModule） */
  loadToolModule: (filePath: string, functionName: string) => Promise<ToolModule>;
  /** 动态 import agent handler（对应 loadAgentModule） */
  loadAgentModule: (filePath: string, hasConfig: boolean, hasRun: boolean) => Promise<AgentModule>;
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
   * @param deps 运行时依赖（访问器 + provider + config）
   * @param depth 递归深度（默认 1 = 根 agent；sub-agent 递归时传入 depth+1）
   */
  constructor(deps: AgentDeps, depth: number = 1) {
    this.deps = deps;
    this.depth = depth;
  }

  /**
   * 非流式执行——组装 config 调 [reactLoop](./reactLoop.md)
   *
   * @param input 用户输入
   * @returns 最终结果（content + messages + turns + stopReason + usage）
   * @throws {AgentError} agent 未注册
   * @throws {ReactLoopError} 超出 maxTurns
   * @throws {Error} provider.complete 抛错时立即传播
   */
  async run(input: string): Promise<ReactLoopResult> {
    const config = await this.buildLoopConfig();
    return reactLoop(input, config);
  }

  /**
   * 流式执行——组装 config 调 [reactLoopStream](./reactLoop.md)
   *
   * @param input 用户输入
   * @yields 流式 chunk（deltaContent / toolCall / toolResult / done）
   * @throws {AgentError} agent 未注册
   * @throws {ReactLoopError} 超出 maxTurns
   * @throws {Error} provider.stream 抛错时立即传播
   */
  async *stream(input: string): AsyncIterable<ReactLoopStreamChunk> {
    const config = await this.buildLoopConfig();
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
   * 组装 ReactLoopConfig
   *
   * 1. 查 agent 元数据（未注册抛 AgentError）
   * 2. buildToolDefinitions 组装 tool 列表
   * 3. config 字段优先级：agent 元数据 > 全局 AgentRuntimeConfig
   */
  private async buildLoopConfig(): Promise<ReactLoopConfig> {
    const meta = this.deps.getAgent(this.deps.agentName);
    if (!meta) {
      throw new AgentError(`Agent "${this.deps.agentName}" is not registered`);
    }

    const tools = await this.buildToolDefinitions();

    return {
      provider: this.deps.provider,
      systemPrompt: meta.systemPrompt,
      model: meta.model,
      maxTurns: meta.maxTurns ?? this.deps.config?.maxTurns,
      tools,
      executeTool: async (name, args) => this.executeTool(name, args),
    };
  }

  /**
   * 组装 LLM 可见 tool 列表
   *
   * 合并三个来源（按 `name` 去重，先入者保留）：
   * 1. **resolveAgentTools** —— agent 显式声明的 `tools` 引用
   * 2. **全局 defaultTools** —— `config.defaultTools` 中的 tool 名（所有 agent 共享）
   * 3. **sub-agent** —— `resolveSubAgents` 每个包装为 `agent.<name>`
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
      const schemaRes = await this.deps.resolveToolSchema?.(tool);
      definitions.set(tool.name, {
        name: tool.name,
        description: tool.description,
        input: schemaRes?.jsonSchema ?? { type: 'object' },
      });
    }

    // 2. 全局 defaultTools（所有 agent 共享，去重）
    const defaultTools = this.deps.config?.defaultTools;
    if (defaultTools) {
      for (const toolName of defaultTools) {
        if (definitions.has(toolName)) continue; // 去重
        const tool = this.deps.getTool(toolName);
        if (!tool) continue; // 未找到的 tool 名静默跳过
        const schemaRes = await this.deps.resolveToolSchema?.(tool);
        definitions.set(tool.name, {
          name: tool.name,
          description: tool.description,
          input: schemaRes?.jsonSchema ?? { type: 'object' },
        });
      }
    }

    // 3. sub-agent（包装为 agent.<name>）
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
   * - `agent.` 前缀 → {@link executeSubAgent} 递归
   * - 常规 tool → `loadToolModule` 加载 handler + 可选 input 校验 → 调用
   *
   * **常规 tool 校验失败**：不抛错，返回 `{ error }` 对象——reactLoop stringify 后
   * 作为 tool 结果回传 LLM，LLM 可据此修正参数重试。
   *
   * **tool 未找到 / 加载失败**：抛错，被 reactLoop catch 后同样回传 LLM。
   */
  private async executeTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    // sub-agent 递归
    if (name.startsWith('agent.')) {
      return this.executeSubAgent(name.slice(6), args);
    }

    // 常规 tool
    const tool = this.deps.getTool(name);
    if (!tool) {
      throw new Error(`Tool "${name}" not found`);
    }

    // 可选 input 校验
    const schemaRes = await this.deps.resolveToolSchema?.(tool);
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
   * 2. sub-agent handler 导出 `run` 时调自定义 `mod.run(args)`
   * 3. 无 `run` 时调 `subAgent.run(JSON.stringify(args))` 走默认 reactLoop
   *
   * 自定义 run 接收原始 args 对象；默认 reactLoop 接收 stringify 后的 args
   * 作为 user 消息（agent-as-tool input 为开放式 JSON）。
   */
  private async executeSubAgent(subName: string, args: Record<string, unknown>): Promise<unknown> {
    const newDepth = this.depth + 1;
    const maxDepth = this.deps.config?.maxAgentDepth ?? DEFAULT_MAX_AGENT_DEPTH;
    if (newDepth > maxDepth) {
      throw new AgentRecursionError(maxDepth, newDepth);
    }

    // 构造子 agent（复用父 deps，仅覆盖 agentName）
    const subDeps: AgentDeps = { ...this.deps, agentName: subName };
    const subAgent = new Agent(subDeps, newDepth);

    // 自定义 run：sub-agent handler 导出 run 函数时走自定义逻辑
    const meta = this.deps.getAgent(subName);
    if (meta?.hasRun) {
      const mod = await this.deps.loadAgentModule(meta.filePath, meta.hasConfig, meta.hasRun);
      if (mod.run) {
        return await mod.run(args);
      }
    }

    // 默认 reactLoop：stringify args 作为 user 消息
    const result = await subAgent.run(typeof args === 'string' ? args : JSON.stringify(args));
    return result.content;
  }
}
