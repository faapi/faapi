import type { ToolMetadata } from '../ast/extractToolMetadata';
import type { AgentMetadata, AgentCore } from '../ast/extractAgentMetadata';
import type { FaapiContext } from '../runtime/contextTypes';
import type { TaskRegistry } from '../task/taskRegistry';
import { createTaskRegistry } from '../task/taskRegistry';

/**
 * app 级注册表（方案 A：注册表实例化）
 *
 * 每个应用实例（`createAppBase`）持有一套独立的注册表，随 app 创建、随
 * `app.close()` 销毁——多 app 同进程（测试 / 嵌入 / 多租户）互不串台。
 * 此前注册表是模块级全局单例 + hydrate 整体替换语义，后创建的 app 会覆盖
 * 先创建的 app 的清单，任一 app close 会清空全部（详见各模块 .md）。
 *
 * 原四个模块（toolRegistry / agentRegistry / skillRegistry / agentHandle）
 * 保留同名全局函数作为**默认实例的便捷访问器**（供编程式直调 / 单元测试 /
 * 无 app 上下文的场景），内部全部路由到本模块的 `defaultRegistries`。
 * 框架自身链路（hydrate / 请求注入 / `@faapi/agent` 插件 / lifecycle 钩子）
 * 一律走 app 实例，不再读写全局默认实例。
 */

// ─── Tool 注册表 ─────────────────────────────────────────────────────

export interface ToolRegistry {
  /** 全量替换（tool 清单来自编译期产物，reload 时整体重新生成） */
  hydrate(tools: ToolMetadata[]): void;
  /** 按全名查找（如 `weather.getWeather`） */
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
  /** 完整元数据（含 filePath / hasRun，供加载 handler.js 执行 run） */
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
        name: `agent.${agent.name}`,
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

// ─── Skill 注册表 ────────────────────────────────────────────────────

export interface SkillRegistry {
  /** 全量替换（DB change stream 场景也可用 upsert 增量） */
  hydrate(skills: AgentCore[]): void;
  /** 增量注册 / 覆盖（业务方监听 DB 单条变更） */
  upsert(skill: AgentCore): void;
  remove(name: string): void;
  get(name: string): AgentCore | undefined;
  list(): AgentCore[];
  clear(): void;
}

export function createSkillRegistry(): SkillRegistry {
  let registry = new Map<string, AgentCore>();
  return {
    hydrate(skills) {
      const next = new Map<string, AgentCore>();
      for (const skill of skills) {
        next.set(skill.name, skill);
      }
      registry = next;
    },
    upsert(skill) {
      registry.set(skill.name, skill);
    },
    remove(name) {
      registry.delete(name);
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

// ─── Agent handle 工厂 ───────────────────────────────────────────────

/** agent handle 工厂函数（由 `@faapi/agent` 插件注册） */
export type AgentHandleFactory = (ctx: FaapiContext) => unknown;

export interface AgentHandleStore {
  /** 注册工厂（null 清理）；二次注册覆盖 */
  register(factory: AgentHandleFactory | null): void;
  /** 工厂已注册时返回 AgentHandle 实例，未注册返回 undefined */
  get(ctx: FaapiContext): unknown;
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

// ─── App 级集合 ──────────────────────────────────────────────────────

/** 一个 app 实例持有的全套注册表 */
export interface AppRegistries {
  tool: ToolRegistry;
  agent: AgentRegistry;
  skill: SkillRegistry;
  task: TaskRegistry;
  agentHandle: AgentHandleStore;
  taskHandle: TaskHandleStore;
}

/** 创建一套 app 级注册表（`createAppBase` 每次调用创建独立实例） */
export function createAppRegistries(): AppRegistries {
  const tool = createToolRegistry();
  const agent = createAgentRegistry(tool);
  const skill = createSkillRegistry();
  const task = createTaskRegistry();
  const agentHandle = createAgentHandleStore();
  const taskHandle = createTaskHandleStore();
  return { tool, agent, skill, task, agentHandle, taskHandle };
}

/**
 * 默认实例：原全局函数的退路（编程式直调 / 单元测试 / 无 app 上下文场景）。
 *
 * 框架自身链路不读写此实例——app 创建自己的 AppRegistries 并在请求链路 /
 * 插件 / lifecycle 钩子中传递。多 app 场景下默认实例无隔离语义（等同旧全局行为）。
 */
export const defaultRegistries: AppRegistries = createAppRegistries();
