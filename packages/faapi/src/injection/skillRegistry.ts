import type { AgentCore } from '../ast/extractAgentMetadata';

/**
 * skill 注册表（单例,运行时动态 skill）
 *
 * 与 [agentRegistry](./agentRegistry.md) 物理隔离,承载 DB-driven skills
 * (业务方在 plugin 里从数据库 / 外部源加载的 skill 元数据)。
 *
 * ## 与 agentRegistry 物理隔离
 *
 * - `agentRegistry` —— 编译期 `faapi-agents.js` 产物一次性水合,dev `reloadAgents`
 *   整体重新替换。来源是文件系统(`src/agents/<name>/handler.ts`)。承载文件型
 *   agent,负责核心流程(含 `run` 函数的多步串联、sub-agent 递归)。
 * - `skillRegistry` —— 运行时动态,业务方 plugin `onReady` 启动期灌入 + DB change
 *   stream 单条增删。来源是数据库 / 外部 API。仅供业务方 plugin 内部使用。
 *
 * 两者职责正交不耦合:**skill 用于拓展**,不参与 agent 查询链路、不覆盖文件型
 * agent、不被 agent 的 `agents` 列表自动引用。agentRegistry 的查询函数
 * (getAgent / listAgents / asTool / resolveAgentTools / resolveSubAgents)
 * **不 fallback 到本模块**。
 *
 * 物理隔离避免 `reloadAgents` 清空 DB skill(dev 模式每次改文件都触发 reload,
 * 业务方手工重新塞 DB skill 不可接受)。
 *
 * ## 存储 AgentCore 而非 AgentMetadata
 *
 * skillRegistry 存储 [AgentCore](../ast/extractAgentMetadata.md) 而非完整
 * `AgentMetadata`——DB skill 无源文件,无需 `filePath` / `hasRun` / `hasConfig`
 * 等代码加载占位字段。业务方从 DB 字段直接映射到 `AgentCore` 的 LLM 可见字段
 * (name / description / systemPrompt / tools / agents / model / maxTurns)即可。
 *
 * 详见 [skillRegistry.md](./skillRegistry.md)。
 */

import { defaultRegistries } from './registries';

/**
 * skill 注册表全局访问器（默认实例便捷入口）
 *
 * 框架推荐路径已改为 **app 实例级注册表**：业务方 plugin 在
 * `lifecycle.onReady(ctx)` 中通过 `ctx.registries.skill` 灌入 DB skill——
 * 这样 skill 与该 app 的生命周期绑定，多 app 同进程互不串台，且 app close
 * 时随实例销毁。
 *
 * 本模块的同名函数保留为**默认实例**的便捷访问器（向后兼容），但注意：
 * 默认实例与 app 实例相互独立——经全局函数灌入的 skill 不会出现在
 * 该 app 的请求链路中。
 *
 * 详见 [skillRegistry.md](./skillRegistry.md) 与 [registries.md](./registries.md)。
 */

/**
 * 水合默认实例的 skill 注册表（全量替换）
 *
 * 框架推荐路径：`lifecycle.onReady(ctx)` 中 `ctx.registries.skill.hydrate(skills)`。
 */
export function hydrateSkillRegistry(skills: AgentCore[]): void {
  defaultRegistries.skill.hydrate(skills);
}

/**
 * 清空默认实例的 skill 注册表
 */
export function clearSkillRegistry(): void {
  defaultRegistries.skill.clear();
}

/**
 * 单条增改默认实例的 skill（运行时增量）
 *
 * 框架推荐路径：`ctx.registries.skill.upsert(skill)`。
 */
export function upsertSkill(core: AgentCore): void {
  defaultRegistries.skill.upsert(core);
}

/**
 * 单条删除默认实例的 skill（幂等）
 */
export function removeSkill(name: string): void {
  defaultRegistries.skill.remove(name);
}

/**
 * 按名查默认实例的单个 skill
 */
export function getSkill(name: string): AgentCore | undefined {
  return defaultRegistries.skill.get(name);
}

/**
 * 返回默认实例所有已注册 skill（副本）
 */
export function listSkills(): AgentCore[] {
  return defaultRegistries.skill.list();
}
