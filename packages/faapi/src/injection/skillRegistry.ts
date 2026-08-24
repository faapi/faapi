import type { AgentCore } from '../ast/extractAgentMetadata';

/**
 * skill 注册表（单例,运行时动态 skill）
 *
 * 与 [agentRegistry](./agentRegistry.md) 物理隔离,承载 DB-driven skills
 * (业务方在 plugin 里从数据库 / 外部源加载的 skill 元数据)。
 *
 * ## 双 registry 设计
 *
 * - `agentRegistry` —— 编译期 `faapi-agents.js` 产物一次性水合,dev `reloadAgents`
 *   整体重新替换。来源是文件系统(`src/agents/<name>/handler.ts`)。
 * - `skillRegistry` —— 运行时动态,业务方 plugin `onReady` 启动期灌入 + DB change
 *   stream 单条增删。来源是数据库 / 外部 API。
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
 * `agentRegistry.getAgent` fallback 到本 registry 时返回 `AgentCore`,
 * 与文件型 agent 的 `getAgent` 返回类型一致(LLM-facing 链路统一)。
 * `agentRegistry.getAgentEntry` **不 fallback**——DB skill 无文件,不走 `loadAgentModule`。
 *
 * ## 查询入口 fallback
 *
 * `agentRegistry.getAgent` / `listAgents` / `resolveAgentTools` / `resolveSubAgents`
 * / `asTool` 在文件 registry 未命中时 fallback 到本模块,自动发现 skill。
 * fallback 优先级:**skill 优先,文件型回退**(同名时 skill 覆盖文件型 agent)。
 *
 * 详见 [skillRegistry.md](./skillRegistry.md)。
 */

/** 内部存储:skill 名 → AgentCore */
let registry: Map<string, AgentCore> = new Map();

/**
 * 水合 skill 注册表(全量替换)
 *
 * 业务方 plugin `lifecycle.onReady` 启动期调用:全量查 DB → 转 `AgentCore[]`
 * → 调本函数灌入。与 `hydrateAgentRegistry` 同构,全量替换而非增量。
 *
 * 运行时增量更新场景(DB change stream)用 [upsertSkill](#upsertSkill) /
 * [removeSkill](#removeSkill),不走本函数。
 *
 * @param skills 从 DB / 外部源加载并转好的 `AgentCore[]`
 */
export function hydrateSkillRegistry(skills: AgentCore[]): void {
  const next = new Map<string, AgentCore>();
  for (const skill of skills) {
    next.set(skill.name, skill);
  }
  registry = next;
}

/**
 * 清空 skill 注册表(app close 时调用)
 *
 * 与 `clearAgentRegistry` 对称,避免测试间状态泄漏。
 */
export function clearSkillRegistry(): void {
  registry = new Map();
}

/**
 * 单条增改 skill(运行时增量)
 *
 * 监听 DB change stream 的 `insert` / `update` 事件时调用。
 * `Map.set` 原子操作,并发安全(多请求同时 upsert 最后一次 wins)。
 *
 * 同名 skill 覆盖(更新),不重复累积。
 *
 * @param core skill 的 LLM 可见元数据
 */
export function upsertSkill(core: AgentCore): void {
  registry.set(core.name, core);
}

/**
 * 单条删除 skill(运行时增量)
 *
 * 监听 DB change stream 的 `delete` 事件时调用。
 * 幂等:删除不存在的 name 静默无操作,不抛错。
 *
 * @param name skill 名
 */
export function removeSkill(name: string): void {
  registry.delete(name);
}

/**
 * 按名查单个 skill
 *
 * @param name skill 名
 * @returns `AgentCore` 或 `undefined`(未注册)
 */
export function getSkill(name: string): AgentCore | undefined {
  return registry.get(name);
}

/**
 * 返回所有已注册 skill
 *
 * 返回副本,调用方修改不影响内部状态(与 `listAgents` / `listTools` 同构)。
 */
export function listSkills(): AgentCore[] {
  return Array.from(registry.values());
}
