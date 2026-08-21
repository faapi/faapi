import type { ToolMetadata } from '../ast/extractToolMetadata';

/**
 * tool 注册表（单例）
 *
 * 由 [createAppBase](../cli/createAppCore.md) 水合 `faapi-tools.js` 后填充，
 * 供 agent 注入器和 reactLoop 按名查找 tool。
 *
 * 单例设计：agent 运行时（`@faapi/agent` 子包）和 faapi 核心的 agent 注入器
 * 都能直接 import 此模块访问，无需传递引用。与路由的 `routesRef`（可变引用容器）
 * 对称，但 tool 无 URL 匹配维度，仅按名查找。
 *
 * 详见 [toolRegistry.md](./toolRegistry.md)。
 */

/** 内部存储：tool 名 → ToolMetadata */
let registry: Map<string, ToolMetadata> = new Map();

/**
 * 水合 tool 注册表（全量替换）
 *
 * 由 `createAppBase` 启动时调用（读 `faapi-tools.js` → `hydrateTools` → 此函数），
 * `createDevApp.reloadTools` 热替换时重新调用。
 *
 * 全量替换而非增量注册：tool 清单来自编译期产物，reload 时整体重新生成，
 * 增量追踪反而复杂。
 *
 * @param tools 从 `faapi-tools.js` 水合还原的 `ToolMetadata[]`
 */
export function hydrateToolRegistry(tools: ToolMetadata[]): void {
  const next = new Map<string, ToolMetadata>();
  for (const tool of tools) {
    next.set(tool.name, tool);
  }
  registry = next;
}

/**
 * 清空注册表（app close 时调用）
 *
 * 与 `setCurrentApp(null)` 对称，避免测试间状态泄漏。
 */
export function clearToolRegistry(): void {
  registry = new Map();
}

/**
 * 按全名查找单个 tool
 *
 * @param tool 全名（如 `weather.getWeather`）
 * @returns `ToolMetadata` 或 `undefined`（未注册）
 */
export function getTool(name: string): ToolMetadata | undefined {
  return registry.get(name);
}

/**
 * 返回所有已注册 tool
 *
 * 返回副本，调用方修改不影响内部状态。
 */
export function listTools(): ToolMetadata[] {
  return Array.from(registry.values());
}
