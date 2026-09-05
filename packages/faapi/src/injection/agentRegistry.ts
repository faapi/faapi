import type { AgentCore, AgentMetadata } from '../ast/extractAgentMetadata';
import { defaultRegistries } from './registries';

// 类型从 registries 转发（AgentToolDescriptor 的定义源已随实例化迁入 registries）
export type { AgentToolDescriptor } from './registries';

/**
 * agent 注册表全局访问器（默认实例便捷入口）
 *
 * 框架自身链路（`createAppBase` 水合 / `@faapi/agent` 插件 deps / `agents`
 * 参数注入）已改为读写 **app 实例级注册表**（见 [registries.md](./registries.md)）——
 * agent 注册表实例在构造时绑定同套 tool 注册表实例（`resolveAgentTools` 跨表查找），
 * 多 app 同进程互不串台。
 *
 * 本模块的同名函数保留为**默认实例**的便捷访问器（语义约束不变：不 fallback 到
 * skillRegistry、Core / Entry 双查询入口），供编程式直调 / 单元测试使用。
 *
 * ## 与 skillRegistry 物理隔离
 *
 * agent 负责核心流程,skill 用于拓展——查询函数不 fallback 到 skillRegistry，
 * 实例化后依旧如此（两套注册表实例互不引用）。
 *
 * 详见 [agentRegistry.md](./agentRegistry.md)。
 */

/**
 * 水合默认实例的 agent 注册表（全量替换）
 *
 * 框架路径请使用 app 实例：`ctx.registries.agent.hydrate(agents)`。
 *
 * @param agents 从 `faapi-agents.js` 水合还原的 `AgentMetadata[]`
 */
export function hydrateAgentRegistry(agents: AgentMetadata[]): void {
  defaultRegistries.agent.hydrate(agents);
}

/**
 * 清空默认实例的 agent 注册表
 *
 * app close 清理的是 app 自己的实例，不经过此函数。
 */
export function clearAgentRegistry(): void {
  defaultRegistries.agent.clear();
}

/**
 * 按名查找单个 agent 的 LLM 可见元数据（默认实例）
 *
 * 返回 [AgentCore](../ast/extractAgentMetadata.md)（不含 filePath / hasRun）。
 * 加载 handler.js 执行 `run` 函数请用 [getAgentEntry](#getAgentEntry)。
 *
 * @param name agent 名（如 `researcher`，含 `@agent` 覆盖值）
 */
export function getAgent(name: string): AgentCore | undefined {
  return defaultRegistries.agent.getAgent(name);
}

/**
 * 按名查找单个 agent 的完整元数据（默认实例，含 filePath / hasRun）
 */
export function getAgentEntry(name: string): AgentMetadata | undefined {
  return defaultRegistries.agent.getAgentEntry(name);
}

/**
 * 返回默认实例所有已注册 agent 的 LLM 可见元数据（副本，仅文件型 agent）
 */
export function listAgents(): AgentCore[] {
  return defaultRegistries.agent.listAgents();
}

/**
 * 把 agent 包装为 tool 描述符（默认实例）
 */
export function asTool(name: string) {
  return defaultRegistries.agent.asTool(name);
}

/**
 * 解析 agent 显式声明的 tool 集合（默认实例，跨查默认 tool 注册表）
 */
export function resolveAgentTools(name: string) {
  return defaultRegistries.agent.resolveAgentTools(name);
}

/**
 * 解析 agent 可调用的子 agent 集合（默认实例，按声明顺序）
 */
export function resolveSubAgents(name: string): AgentCore[] {
  return defaultRegistries.agent.resolveSubAgents(name);
}
