import type { FaapiContext } from '../runtime/contextTypes';

/**
 * agent handle 工厂注册表（单例）
 *
 * 让 `@faapi/agent` 插件在启动时注册「请求级 agent handle 工厂」，
 * [injectParams](./injectParams.md) 在 `agent` 参数注入时调工厂拿到 `AgentHandle` 实例。
 *
 * 解耦设计：faapi 核心不依赖 `@faapi/agent`——核心只提供注册 / 查询点，
 * 工厂返回 `unknown`，具体类型由 `@faapi/agent` 的 `AgentHandle` 接口定义。
 *
 * 详见 [agentHandle.md](./agentHandle.md)。
 */

/** agent handle 工厂函数（由 `@faapi/agent` 插件注册） */
export type AgentHandleFactory = (ctx: FaapiContext) => unknown;

/** 内部存储：当前注册的工厂（null 表示未注册） */
let currentFactory: AgentHandleFactory | null = null;

/**
 * 注册 agent handle 工厂
 *
 * 由 `@faapi/agent` 插件在 `setup()` 时调用，传入创建 `AgentHandle` 的工厂函数。
 * 二次注册覆盖第一次（与 `hydrateAgentRegistry` 全量替换同构）。
 *
 * 传入 `null` 等效于 [clearAgentHandleFactory](#clearAgentHandleFactory)。
 *
 * @param factory 工厂函数或 `null`（清理）
 */
export function registerAgentHandleFactory(factory: AgentHandleFactory | null): void {
  currentFactory = factory;
}

/**
 * 获取 agent handle（由 [injectParams](./injectParams.md) 调用）
 *
 * 工厂已注册时调工厂返回 `AgentHandle`，未注册时返回 `undefined`。
 *
 * @param ctx 请求上下文（工厂可选择使用请求级信息）
 * @returns `AgentHandle` 实例或 `undefined`
 */
export function getAgentHandle(ctx: FaapiContext): unknown {
  if (currentFactory === null) return undefined;
  return currentFactory(ctx);
}

/**
 * 清空工厂注册（app close / 测试清理时调用）
 *
 * 与 `clearAgentRegistry` / `clearToolRegistry` 对称，避免测试间状态泄漏。
 */
export function clearAgentHandleFactory(): void {
  currentFactory = null;
}
