import type { AgentMetadata } from '../ast/extractAgentMetadata';
import type { ToolMetadata } from '../ast/extractToolMetadata';
import { getTool } from './toolRegistry';

/**
 * agent 注册表（单例）
 *
 * 由 [createAppBase](../cli/createAppCore.md) 水合 `faapi-agents.js` 后填充，
 * 供 agent 注入器和 `@faapi/agent` 子包按名查找 agent 元数据、解析 agent 可用 tool
 * 集合、把 agent 包装为 tool 供其他 agent 调用。
 *
 * 单例设计：agent 运行时（`@faapi/agent` 子包）和 faapi 核心的 agent 注入器
 * 都能直接 import 此模块访问，无需传递引用。与 [toolRegistry](./toolRegistry.md) 对称。
 *
 * Phase 2.2 扩展三类能力：
 * - `asTool(name)` — agent 包装为 `AgentToolDescriptor` 供 LLM 当 tool 调用
 * - `resolveAgentTools(name)` — 解析 agent 可用 tool 集合（agent 显式声明的 `tools` 引用）
 * - `resolveSubAgents(name)` — 解析 agent 可调用的子 agent 集合（来自 `agent.agents` 字段）
 *
 * 详见 [agentRegistry.md](./agentRegistry.md)。
 */

/** 内部存储：agent 名 → AgentMetadata */
let registry: Map<string, AgentMetadata> = new Map();

/**
 * 水合 agent 注册表（全量替换）
 *
 * 由 `createAppBase` 启动时调用（读 `faapi-agents.js` → `hydrateAgents` → 此函数），
 * `createDevApp.reloadAgents` 热替换时重新调用。
 *
 * 全量替换而非增量注册：agent 清单来自编译期产物，reload 时整体重新生成，
 * 增量追踪反而复杂（与 `hydrateToolRegistry` 同构）。
 *
 * @param agents 从 `faapi-agents.js` 水合还原的 `AgentMetadata[]`
 */
export function hydrateAgentRegistry(agents: AgentMetadata[]): void {
  const next = new Map<string, AgentMetadata>();
  for (const agent of agents) {
    next.set(agent.name, agent);
  }
  registry = next;
}

/**
 * 清空注册表（app close 时调用）
 *
 * 与 `clearToolRegistry` / `setCurrentApp(null)` 对称，避免测试间状态泄漏。
 */
export function clearAgentRegistry(): void {
  registry = new Map();
}

/**
 * 按名查找单个 agent
 *
 * @param name agent 名（如 `researcher`，含 `@agent` 覆盖值）
 * @returns `AgentMetadata` 或 `undefined`（未注册）
 */
export function getAgent(name: string): AgentMetadata | undefined {
  return registry.get(name);
}

/**
 * 返回所有已注册 agent
 *
 * 返回副本，调用方修改不影响内部状态（与 `listTools` 同构）。
 */
export function listAgents(): AgentMetadata[] {
  return Array.from(registry.values());
}

/**
 * agent 包装为 tool 的描述符
 *
 * 与 [ToolMetadata](../ast/extractToolMetadata.md) 平行结构，供 reactLoop 把
 * agent 当作 tool 发给 LLM。reactLoop 按 `kind` 字段路由执行：
 * - `'tool'` → `loadToolModule` 加载 handler 函数
 * - `'agent'` → `loadAgentModule` 加载 agent handler + 递归 reactLoop
 *
 * `name` 加 `agent.` 前缀避免与常规 tool 冲突，reactLoop 据此识别 sub-agent 递归。
 * 不含 input schema——agent `run` 函数参数为开放式（任意 JSON），无类型约束。
 */
export interface AgentToolDescriptor {
  /** 标识此 tool 实际是 agent（reactLoop 据此走 sub-agent 递归） */
  kind: 'agent';
  /** tool 名（默认 `agent.<agentName>`，避免与常规 tool 冲突） */
  name: string;
  /** agent 名（不含前缀，用于按名查找 agent 元数据） */
  agentName: string;
  /** 描述（对 LLM 可见，来自 `agent.description`），无 JSDoc 描述时为 `undefined` */
  description?: string;
  /** agent 元数据引用（reactLoop 取 `systemPrompt` / `model` / `maxTurns` / `filePath` 等） */
  metadata: AgentMetadata;
}

/**
 * 把 agent 包装为 `AgentToolDescriptor` 供 LLM 当 tool 调用
 *
 * 通常配合 [resolveSubAgents](#resolveSubAgents) 使用——把父 agent 的 `agents` 列表
 * 中的每个子 agent 包装为 tool，加入 LLM 可见 tool 列表。
 *
 * @param name agent 名
 * @returns `AgentToolDescriptor` 或 `undefined`（agent 未注册）
 */
export function asTool(name: string): AgentToolDescriptor | undefined {
  const agent = registry.get(name);
  if (!agent) return undefined;
  return {
    kind: 'agent',
    name: `agent.${agent.name}`,
    agentName: agent.name,
    description: agent.description,
    metadata: agent,
  };
}

/**
 * 解析 agent 可用 tool 集合
 *
 * 只返回 agent 显式声明的 tool（agent config 块的 `tools` 字段）。
 * 不在此处合并全局 `defaultTools`——`defaultTools` 的合并由 `@faapi/agent` 的
 * `Agent.buildToolDefinitions` 在更上层完成（与 sub-agent 一起按 `name` 去重）。
 * `resolveAgentTools` 只关心 agent 自身显式声明的部分，职责单一。
 *
 * agent 必须显式声明用哪些 tool，显式优于隐式。
 *
 * `tools` 中未在 toolRegistry 找到的 tool 名静默跳过（tool 可选可用，不强制存在）。
 *
 * 跨注册表依赖 [toolRegistry](./toolRegistry.ts) 的 `getTool`，
 * 两个注册表由 `createAppBase` 在同一启动阶段水合。
 *
 * @param name agent 名
 * @returns `ToolMetadata[]`（agent 未注册返回空数组）
 */
export function resolveAgentTools(name: string): ToolMetadata[] {
  const agent = registry.get(name);
  if (!agent) return [];

  const result = new Map<string, ToolMetadata>();

  // agent 显式声明的 tool（config 块的 `tools` 字段）
  if (agent.tools) {
    for (const toolName of agent.tools) {
      const tool = getTool(toolName);
      if (tool) result.set(tool.name, tool);
      // 未找到的 tool 名静默跳过（tool 可选可用，不强制存在）
    }
  }

  return Array.from(result.values());
}

/**
 * 解析 agent 可调用的子 agent 集合
 *
 * 读 `agent.agents` 字段（[extractAgentMetadata](../ast/extractAgentMetadata.md)
 * 提取的 `config.agents` 字面量列表），按名查找已注册 agent。
 *
 * reactLoop 组装 LLM tool 列表：
 * ```ts
 * const tools = [
 *   ...resolveAgentTools(name),                                    // 常规 tool
 *   ...resolveSubAgents(name).map((a) => asTool(a.name)!),        // agent-as-tool
 * ];
 * ```
 *
 * @param name agent 名
 * @returns `AgentMetadata[]`（`agents` 未设置 / agent 未注册返回空数组）
 */
export function resolveSubAgents(name: string): AgentMetadata[] {
  const agent = registry.get(name);
  if (!agent || !agent.agents) return [];

  const result: AgentMetadata[] = [];
  for (const agentName of agent.agents) {
    const subAgent = registry.get(agentName);
    if (subAgent) result.push(subAgent);
    // 未注册的 agent 名跳过（agent 可选可用，不强制存在）
  }
  return result;
}
