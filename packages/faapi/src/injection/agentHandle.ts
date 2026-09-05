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

import { defaultRegistries } from './registries';

/**
 * agent handle 工厂全局访问器（默认实例便捷入口）
 *
 * 框架路径已改为 app 实例：`@faapi/agent` 插件在 setup 时经
 * `ctx.registries.agentHandle.register(factory)` 注册到**当前 app 的实例**，
 * 请求注入经 `ctx.registries.agentHandle.get(ctx)` 读取——多 app 同进程互不覆盖。
 * 此前模块级单值会让第二个 app 的插件注册覆盖第一个。
 *
 * 本模块的同名函数保留为默认实例便捷访问器（向后兼容）。
 *
 * 详见 [agentHandle.md](./agentHandle.md) 与 [registries.md](./registries.md)。
 */

/**
 * 注册默认实例的 agent handle 工厂
 *
 * 框架路径请使用 `ctx.registries.agentHandle.register(factory)`（PluginContext 提供）。
 * 传入 `null` 等效于清理。
 */
export function registerAgentHandleFactory(factory: AgentHandleFactory | null): void {
  defaultRegistries.agentHandle.register(factory);
}

/**
 * 从默认实例获取 agent handle（工厂未注册时返回 undefined）
 */
export function getAgentHandle(ctx: FaapiContext): unknown {
  return defaultRegistries.agentHandle.get(ctx);
}

/**
 * 清空默认实例的工厂注册
 */
export function clearAgentHandleFactory(): void {
  defaultRegistries.agentHandle.clear();
}
