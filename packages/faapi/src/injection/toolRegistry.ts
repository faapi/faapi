import type { ToolMetadata } from '../ast/extractToolMetadata';
import { defaultRegistries } from './registries';

/**
 * tool 注册表全局访问器（默认实例便捷入口）
 *
 * 框架自身链路（`createAppBase` 水合 / 请求注入 / `@faapi/agent` 插件）已改为
 * 读写 **app 实例级注册表**（见 [registries.md](./registries.md)）——每个 app
 * 持有独立实例，随 app 创建/销毁，多 app 同进程互不串台。
 *
 * 本模块的同名函数保留为**默认实例**的便捷访问器，供编程式直调 / 单元测试 /
 * 无 app 上下文的场景使用；多 app 场景下默认实例无隔离语义（等同旧全局行为），
 * 框架路径不再读写它。
 *
 * 详见 [toolRegistry.md](./toolRegistry.md)。
 */

/**
 * 水合默认实例的 tool 注册表（全量替换）
 *
 * 框架路径请使用 app 实例：`ctx.registries.tool.hydrate(tools)`。
 *
 * @param tools 从 `faapi-tools.js` 水合还原的 `ToolMetadata[]`
 */
export function hydrateToolRegistry(tools: ToolMetadata[]): void {
  defaultRegistries.tool.hydrate(tools);
}

/**
 * 清空默认实例的 tool 注册表
 *
 * app close 清理的是 app 自己的实例，不经过此函数。
 */
export function clearToolRegistry(): void {
  defaultRegistries.tool.clear();
}

/**
 * 按全名查找单个 tool（默认实例）
 *
 * 框架路径（`@faapi/agent` 插件 / 请求注入）从 app 实例查找。
 *
 * @param tool 全名（如 `weather.getWeather`）
 * @returns `ToolMetadata` 或 `undefined`（未注册）
 */
export function getTool(name: string): ToolMetadata | undefined {
  return defaultRegistries.tool.get(name);
}

/**
 * 返回默认实例所有已注册 tool（副本）
 */
export function listTools(): ToolMetadata[] {
  return defaultRegistries.tool.list();
}
