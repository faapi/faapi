# toolTypes

一句话概括：定义 tool 相关的核心类型，包括 tool 清单记录。

## 为什么需要

tool 层多个模块（扫描、生成产物、加载、注册表）共享同一套类型定义。集中定义避免循环依赖和类型不一致。

## 使用场景

- `scanTools` 返回 `ToolManifest[]`
- `generateToolArtifacts` 序列化 / `hydrateTools` 水合 `ToolManifest`
- `toolRegistry` 持有 `ToolManifest[]` 提供 `getTool` / `listTools`
- `agentRegistry` 按 agent 显式声明的 `tools` 解析可用 tool 集合

## ToolManifest 字段说明

| 字段 | 类型 | 用途 |
|------|------|------|
| `name` | `string` | tool 名，格式 `子目录.函数名`（如 `weather.getWeather`），无子目录时纯函数名。对 LLM 可见。可被 `@tool` JSDoc 覆盖（见 [extractToolMetadata](../ast/extractToolMetadata.md)） |
| `functionName` | `string` | 源码中的真实导出函数名（如 `getWeather`）。供 `extractToolMetadata` 在源文件中定位函数节点提取 JSDoc/参数类型。`@tool` 覆盖 `name` 但不覆盖 `functionName` |
| `filePath` | `string` | 源码相对路径（如 `src/tools/weather/handler.ts`），AST schema 提取需要 `.ts` |

`functionName` 单独保留（不靠 `name.split('.').pop()` 反推）的理由：显式字段比正则切分更稳健，且 `@tool` 覆盖 `name` 后无法从 `name` 反推原函数名。

## 相关模块

- [scanTools](./scanTools.md) - 生成 `ToolManifest[]`
- [parseToolFile](./parseToolFile.md) - tool 文件路径解析（命名空间生成）
- [generateToolArtifacts](../cli/generateToolArtifacts.md) - 序列化/水合 `ToolManifest`
- [toolRegistry](../injection/toolRegistry.md) - 运行时 tool 注册表
