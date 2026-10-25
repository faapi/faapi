import type { ToolMetadata } from '../ast/extractToolMetadata';
import type { AgentMetadata, AgentCore } from '../ast/extractAgentMetadata';
import type { FaapiContext } from '../runtime/contextTypes';
import type { AgentToolContext } from '../runtime/agentToolContext';
import type { ReminderPhase } from '../configs/configTypes';
import type { TaskRegistry } from '../tasks/taskRegistry';
import { createTaskRegistry } from '../tasks/taskRegistry';
import type { LlmComplete } from './llmTypes';
import { subAgentToolName } from './subAgentToolName';

/**
 * app 级注册表（方案 A：注册表实例化）
 *
 * 每个应用实例（`createAppBase`）持有一套独立的注册表，随 app 创建、随
 * `app.close()` 销毁——多 app 同进程（测试 / 嵌入 / 多租户）互不串台。
 * 此前注册表是模块级全局单例 + hydrate 整体替换语义，后创建的 app 会覆盖
 * 先创建的 app 的清单，任一 app close 会清空全部（详见各模块 .md）。
 *
 * 原三个模块（toolRegistry / agentRegistry / agentHandle）
 * 保留同名全局函数作为**默认实例的便捷访问器**（供编程式直调 / 单元测试 /
 * 无 app 上下文的场景），内部全部路由到本模块的 `defaultRegistries`。
 * 框架自身链路（hydrate / 请求注入 / `@faapi/agent` 插件 / lifecycle 钩子）
 * 一律走 app 实例，不再读写全局默认实例。
 */

// ─── Tool 注册表 ─────────────────────────────────────────────────────

export interface ToolRegistry {
  /** 全量替换（tool 清单来自编译期产物，reload 时整体重新生成） */
  hydrate(tools: ToolMetadata[]): void;
  /** 按全名查找（如 `weather_getWeather`） */
  get(name: string): ToolMetadata | undefined;
  /** 所有已注册 tool（副本） */
  list(): ToolMetadata[];
  clear(): void;
}

export function createToolRegistry(): ToolRegistry {
  let registry = new Map<string, ToolMetadata>();
  return {
    hydrate(tools) {
      const next = new Map<string, ToolMetadata>();
      for (const tool of tools) {
        next.set(tool.name, tool);
      }
      registry = next;
    },
    get(name) {
      return registry.get(name);
    },
    list() {
      return Array.from(registry.values());
    },
    clear() {
      registry = new Map();
    },
  };
}

// ─── Agent 注册表 ────────────────────────────────────────────────────

/** agent 包装为 tool 的描述符（reactLoop 据此识别 sub-agent 递归） */
export interface AgentToolDescriptor {
  kind: 'agent';
  name: string;
  agentName: string;
  description?: string;
  metadata: AgentCore;
}

export interface AgentRegistry {
  /** 全量替换（与 hydrateToolRegistry 同构） */
  hydrate(agents: AgentMetadata[]): void;
  /** LLM 可见元数据（AgentCore） */
  getAgent(name: string): AgentCore | undefined;
  /** 完整元数据（含 filePath，声明文件定位） */
  getAgentEntry(name: string): AgentMetadata | undefined;
  /** 所有已注册 agent 的 LLM 可见元数据（副本） */
  listAgents(): AgentCore[];
  /** 包装为 tool 描述符 */
  asTool(name: string): AgentToolDescriptor | undefined;
  /**
   * 解析 agent 显式声明的 tool 集合。
   * 跨注册表依赖：经由构造时绑定的 tool 注册表查找（同属一套 AppRegistries，
   * 由 createAppBase 在同一启动阶段水合）
   */
  resolveAgentTools(name: string): ToolMetadata[];
  /** 解析 agent 可调用的子 agent 集合 */
  resolveSubAgents(name: string): AgentCore[];
  clear(): void;
}

export function createAgentRegistry(tool: ToolRegistry): AgentRegistry {
  let registry = new Map<string, AgentMetadata>();

  const getAgent = (name: string): AgentCore | undefined => registry.get(name);

  return {
    hydrate(agents) {
      const next = new Map<string, AgentMetadata>();
      for (const agent of agents) {
        next.set(agent.name, agent);
      }
      registry = next;
    },
    getAgent,
    getAgentEntry(name) {
      return registry.get(name);
    },
    listAgents() {
      const merged = new Map<string, AgentCore>();
      for (const agent of registry.values()) merged.set(agent.name, agent);
      return Array.from(merged.values());
    },
    asTool(name) {
      const agent = getAgent(name);
      if (!agent) return undefined;
      return {
        kind: 'agent',
        name: subAgentToolName(agent.name),
        agentName: agent.name,
        description: agent.description,
        metadata: agent,
      };
    },
    resolveAgentTools(name) {
      const agent = getAgent(name);
      if (!agent) return [];

      const result = new Map<string, ToolMetadata>();
      if (agent.tools) {
        for (const toolName of agent.tools) {
          const resolved = tool.get(toolName);
          if (resolved) result.set(resolved.name, resolved);
          // 未找到的 tool 名静默跳过（tool 可选可用，不强制存在）
        }
      }
      return Array.from(result.values());
    },
    resolveSubAgents(name) {
      const agent = getAgent(name);
      if (!agent || !agent.agents) return [];

      const result: AgentCore[] = [];
      for (const subName of agent.agents) {
        const sub = getAgent(subName);
        if (sub) result.push(sub);
        // 未注册的 agent 名跳过（agent 可选可用，不强制存在）
      }
      return result;
    },
    clear() {
      registry = new Map();
    },
  };
}

// ─── Agent handle 工厂 ───────────────────────────────────────────────

/**
 * agent handle 工厂函数（由 `@faapi/agent` 插件注册）
 *
 * 入参为 [AgentToolContext](../runtime/agentToolContext.md) 契约（必有、基础字段
 * 三路径合成保证）——HTTP 路径经 `toAgentToolContext` 从完整请求 ctx 收窄，
 * 任务路径由 taskQueue 以 carry + 任务级能力合成。
 */
export type AgentHandleFactory = (ctx: AgentToolContext) => unknown;

export interface AgentHandleStore {
  /** 注册工厂（null 清理）；二次注册覆盖 */
  register(factory: AgentHandleFactory | null): void;
  /** 工厂已注册时返回 AgentHandle 实例，未注册返回 undefined */
  get(ctx: AgentToolContext): unknown;
  clear(): void;
}

export function createAgentHandleStore(): AgentHandleStore {
  let currentFactory: AgentHandleFactory | null = null;
  return {
    register(factory) {
      currentFactory = factory;
    },
    get(ctx) {
      if (currentFactory === null) return undefined;
      return currentFactory(ctx);
    },
    clear() {
      currentFactory = null;
    },
  };
}

// ─── LLM 补全通道 store ──────────────────────────────────────────────

/**
 * 轻量 LLM 补全通道 store（由 `@faapi/agent` 插件注册）
 *
 * 与 AgentHandleStore 同形态（app 实例级、随 app 生命周期），差异：channel 与
 * 请求上下文无关——存实例本身而非工厂。handler 的 `llm` 注入参数与任务执行
 * 上下文（进程内路径）读取；插件未加载时为空（注入 `undefined`）。
 */
export interface LlmChannelStore {
  /** 注册 channel（null 清理）；二次注册覆盖 */
  register(channel: LlmComplete | null): void;
  /** channel 已注册时返回实例，未注册返回 undefined */
  get(): LlmComplete | undefined;
  clear(): void;
}

export function createLlmChannelStore(): LlmChannelStore {
  let current: LlmComplete | null = null;
  return {
    register(channel) {
      current = channel;
    },
    get() {
      return current ?? undefined;
    },
    clear() {
      current = null;
    },
  };
}

// ─── Task handle 工厂 ────────────────────────────────────────────────

/** task 客户端工厂函数（由 createAppBase 注册，返回 TaskClient 门面） */
export type TaskHandleFactory = (ctx: FaapiContext) => unknown;

export interface TaskHandleStore {
  /** 注册工厂（null 清理）；二次注册覆盖 */
  register(factory: TaskHandleFactory | null): void;
  /** 工厂已注册时返回 TaskClient，未注册返回 undefined */
  get(ctx: FaapiContext): unknown;
  clear(): void;
}

export function createTaskHandleStore(): TaskHandleStore {
  let currentFactory: TaskHandleFactory | null = null;
  return {
    register(factory) {
      currentFactory = factory;
    },
    get(ctx) {
      if (currentFactory === null) return undefined;
      return currentFactory(ctx);
    },
    clear() {
      currentFactory = null;
    },
  };
}

// ─── 隔离任务工具执行器 store ────────────────────────────────────────

/**
 * 隔离任务工具执行器（由 `@faapi/agent` 插件注册）
 *
 * 隔离 worker 的 agent 编排循环把业务函数面（工具 handler、鉴权钩子、派发钩子）
 * 经 RPC 回传宿主执行——worker 只跑 LLM 调用与编排决策，db 连接池等资源单实例、
 * 钩子无需跨线程。执行器与 `Agent.executeTool` 常规分支共用同一实现
 * （`@faapi/agent` 的 `executeToolCall`）。方法返回值/参数均须可结构化克隆
 * （跨 postMessage 边界，不可克隆按执行错误显式失败）。
 *
 * 各方法 ctx 为宿主侧按任务合成的 [AgentToolContext](../runtime/agentToolContext.md)
 * （carry + scoped TaskClient + 任务级 logger + job.signal，与进程内
 * `taskCtx.agent` 同配方，见 taskToolContext.md）。
 */
export interface AgentToolRunner {
  /** 执行守卫钩子（覆盖常规 tool 与 sub-agent 派发；void 放行 / { error } 拒绝 / { args } 改写） */
  beforeToolCall(
    ctx: AgentToolContext,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<unknown>;
  /** 单次 tool 调用（schema 校验失败返回 { error }；handler 抛错原样上抛） */
  toolCall(
    ctx: AgentToolContext,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<unknown>;
  /** 可见性过滤钩子（tools 为 OpenAI 规范形数组，返回过滤后数组） */
  filterTools(ctx: AgentToolContext, tools: unknown[]): Promise<unknown[]>;
  /** sub-agent 派发入参改写钩子（未接线时 undefined 原样放行） */
  resolveSubAgentInput(
    ctx: AgentToolContext,
    subName: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown> | undefined>;
  /** sub-agent 派发上下文钩子（未接线时 undefined 跳过注入） */
  resolveSubAgentContext(
    ctx: AgentToolContext,
    subName: string,
    args: Record<string, unknown>,
  ): Promise<string | undefined>;
  /**
   * 提醒供数钩子（reminders，见 `@faapi/agent` 的 reminders.md）
   *
   * 宿主侧全量合并（`config.agent.reminders` + agent meta.reminders）并渲染指定
   * 通道，返回**未包裹内容串数组**（包裹由 worker 侧引擎统一做；`undefined` = 该
   * 通道无提醒）。`info.phase`：`'once'`（fresh run 循环启动一次，turn=0）|
   * `'everyTurn'`（每轮 LLM 请求前，turn 为当轮序号 1 起）。`info.ctx` 不跨线程
   * ——worker 垫片不外传 ctx，此处以任务合成 ctx 调用 builder。
   */
  resolveReminders(
    ctx: AgentToolContext,
    info: { agentName: string; depth: number; turn: number; phase: ReminderPhase },
  ): Promise<string[] | undefined>;
}

/** 隔离任务工具执行器 store（app 实例级，随 app 生命周期；与 LlmChannelStore 同形态） */
export interface AgentToolRunnerStore {
  /** 注册执行器（null 清理）；二次注册覆盖 */
  register(runner: AgentToolRunner | null): void;
  /** 执行器已注册时返回实例，未注册返回 undefined */
  get(): AgentToolRunner | undefined;
  clear(): void;
}

export function createAgentToolRunnerStore(): AgentToolRunnerStore {
  let current: AgentToolRunner | null = null;
  return {
    register(runner) {
      current = runner;
    },
    get() {
      return current ?? undefined;
    },
    clear() {
      current = null;
    },
  };
}

// ─── App 级集合 ──────────────────────────────────────────────────────

/** 一个 app 实例持有的全套注册表 */
export interface AppRegistries {
  tool: ToolRegistry;
  agent: AgentRegistry;
  task: TaskRegistry;
  agentHandle: AgentHandleStore;
  taskHandle: TaskHandleStore;
  /** 轻量 LLM 补全通道（`@faapi/agent` 插件注册；未加载插件时为空） */
  llm: LlmChannelStore;
  /** 隔离任务工具执行器（`@faapi/agent` 插件注册；未加载插件时为空——worker 内 taskCtx.agent 不挂载） */
  agentToolRunner: AgentToolRunnerStore;
}

/**
 * 任务侧注册表只读视图（AppRegistries 的查询投影）
 *
 * 注入任务执行上下文（`TaskContext.registries`）——任务执行侧不在 handler 请求链路上
 * （拿不到 `FaapiContext.registries`），`getApp()` 在隔离 worker 线程内也不可用
 * （globalThis 独立）。刻意不暴露 `hydrate`/`clear` 写接口：任务不是注册表的所有者。
 */
export interface TaskRegistriesView {
  agent: Pick<
    AgentRegistry,
    | 'getAgent'
    | 'getAgentEntry'
    | 'listAgents'
    | 'asTool'
    | 'resolveAgentTools'
    | 'resolveSubAgents'
  >;
  tool: Pick<ToolRegistry, 'get' | 'list'>;
}

/** 从 AppRegistries 构造任务侧只读视图（活引用——进程内执行路径直接使用） */
export function createTaskRegistriesView(registries: AppRegistries): TaskRegistriesView {
  return {
    agent: {
      getAgent: (name) => registries.agent.getAgent(name),
      getAgentEntry: (name) => registries.agent.getAgentEntry(name),
      listAgents: () => registries.agent.listAgents(),
      asTool: (name) => registries.agent.asTool(name),
      resolveAgentTools: (name) => registries.agent.resolveAgentTools(name),
      resolveSubAgents: (name) => registries.agent.resolveSubAgents(name),
    },
    tool: {
      get: (name) => registries.tool.get(name),
      list: () => registries.tool.list(),
    },
  };
}

/** 空视图（`createTaskQueue` 未传 registries 时的兜底——直接构造队列的测试/嵌入场景） */
export function createEmptyTaskRegistriesView(): TaskRegistriesView {
  return {
    agent: {
      getAgent: () => undefined,
      getAgentEntry: () => undefined,
      listAgents: () => [],
      asTool: () => undefined,
      resolveAgentTools: () => [],
      resolveSubAgents: () => [],
    },
    tool: { get: () => undefined, list: () => [] },
  };
}

/** 创建一套 app 级注册表（`createAppBase` 每次调用创建独立实例） */
export function createAppRegistries(): AppRegistries {
  const tool = createToolRegistry();
  const agent = createAgentRegistry(tool);
  const task = createTaskRegistry();
  const agentHandle = createAgentHandleStore();
  const taskHandle = createTaskHandleStore();
  const llm = createLlmChannelStore();
  const agentToolRunner = createAgentToolRunnerStore();
  return { tool, agent, task, agentHandle, taskHandle, llm, agentToolRunner };
}

/**
 * 默认实例：原全局函数的退路（编程式直调 / 单元测试 / 无 app 上下文场景）。
 *
 * 框架自身链路不读写此实例——app 创建自己的 AppRegistries 并在请求链路 /
 * 插件 / lifecycle 钩子中传递。多 app 场景下默认实例无隔离语义（等同旧全局行为）。
 */
export const defaultRegistries: AppRegistries = createAppRegistries();
