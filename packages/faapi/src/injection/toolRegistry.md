# toolRegistry

一句话概括：tool 注册表单例，由 `createAppBase` 水合 `faapi-tools.js` 后填充，供 agent 注入器和 reactLoop 按名查找 tool。

## 为什么需要

agent 调用 tool 时需要按名查找 tool 元数据（`filePath` / `functionName` / `description` 等）。`faapi-tools.js` 是序列化产物（`SerializedToolRecord[]`），启动时需还原为 `ToolMetadata[]` 并放入一个可查询的注册表。

与路由的 `routesRef`（可变引用容器）对称，但 tool 没有 URL 匹配维度，仅按名查找，故用单例注册表而非 ref 容器——agent 运行时（`@faapi/agent` 子包）和 faapi 核心的 agent 注入器都能直接 import 此模块访问，无需传递引用。

## 使用场景

- `createAppBase` 启动时水合 `faapi-tools.js` → `hydrateToolRegistry()`
- `createDevApp.reloadTools` 热替换时重新水合（dev watcher 触发）
- agent 注入器（`injectParams`）按 `agent` 参数名查找可用 tool 列表
- `@faapi/agent` 子包的 `Agent` 类 / reactLoop 按 `tool.name` 查找元数据，再调 `loadToolModule` 加载 handler 执行

## 设计

### 单例 + 全量替换

- `hydrateToolRegistry(tools)` —— 全量替换注册表内容（启动 + reload 调用）
- `clearToolRegistry()` —— 清空（app close 时调用，与 `setCurrentApp(null)` 对称）

全量替换而非增量注册：tool 清单来自编译期产物，reload 时整体重新生成，增量追踪反而复杂。

### 查询 API

| 方法 | 说明 |
| --- | --- |
| `getTool(name)` | 按全名查找单个 tool（如 `weather.getWeather`），未找到返回 `undefined` |
| `listTools()` | 返回所有已注册 tool |

> agent 可用 tool 集合由 [agentRegistry](./agentRegistry.md) 的 `resolveAgentTools` 解析（agent 显式声明的 `tools` + 全局 `defaultTools`），不在本模块。

### faapi-tools.js 缺失处理

项目可能没有任何 tool（纯 API 项目）。`faapi-tools.js` 不存在时，`createAppBase` 跳过水合，注册表保持空——与 `faapi-routes.js`（必需）不同，tool 是可选能力。

## 相关模块

- [generateToolArtifacts](../cli/generateToolArtifacts.md) - 生成 `faapi-tools.js` + tool `zod.js`
- [extractToolMetadata](../ast/extractToolMetadata.md) - `ToolMetadata` 类型定义
- [loadToolModule](../loader/loadToolModule.md) - 按 `filePath` + `functionName` 按需加载 tool handler
- [createAppCore](../cli/createAppCore.md) - 启动时水合入口
- [agentRegistry](./agentRegistry.md) - agent 注册表（Phase 2.2，`resolveAgentTools` 解析 agent 可用 tool）
