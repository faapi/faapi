# loadToolSchema

一句话概括：动态加载 tool 的 `zod.js` schema 模块，返回 zod schema 对象（`unknown` 类型，由 `@faapi/agent` 断言为 zod schema 用于 `z.toJSONSchema` + `safeParse`）。zod.js 不存在或加载失败时返回 `undefined`（tool input 用自由 schema `{ type: 'object' }`）。

## 为什么需要

`@faapi/agent` 的 `resolveToolSchema` 需要 tool 的 JSON Schema（发给 LLM）+ 执行前校验（zod `safeParse`）。两者都依赖 tool 的 `zod.js` 产物——由 `generateToolArtifacts` 在 build/dev 阶段生成，导出 `${inputTypeName}Schema` zod schema 对象。

faapi 核心不依赖 zod（zod 是 peerDep），因此 `loadToolSchema` 返回 `unknown` 类型的 schema 对象，由 `@faapi/agent` 负责类型断言 + 调用 `z.toJSONSchema` / `safeParse`。

与 [loadToolModule](./loadToolModule.md) 对称——一个加载 handler.js（tool 函数），一个加载 zod.js（tool schema）。

## 使用场景

- `@faapi/agent` 的 `plugin.ts` 实现 `resolveToolSchema`：加载 zod.js → `z.toJSONSchema(schema)` 生成 JSON Schema 发给 LLM → `schema.safeParse(input)` 校验 LLM 返回的参数
- `agent.run` 调用 tool 前的 input 校验（`AgentDeps.resolveToolSchema?.(tool)` → `ToolSchemaResolution.validate(args)`）
- `@faapi/agent` 的跨请求 schema 缓存用 [getToolSchemaPath](#gettooltlschemapath) 计算缓存键 + mtime 校验目标

## 导出

| 函数 | 说明 |
| --- | --- |
| `loadToolSchema(tool, rootDir?)` | 动态加载 tool 的 zod.js，返回 `{ schema, schemaName } \| undefined` |
| `getToolSchemaPath(tool, rootDir?)` | 计算 zod.js 绝对路径（纯路径计算，无 fs 访问；与 `loadToolSchema` 内部逻辑同源，共享 `getDist()`） |

## 流程

```
loadToolSchema(tool, rootDir)
  ├─ tool.inputTypeName 为 undefined → 返回 undefined（无 schema，用自由 schema）
  ├─ getDist()：dev 按需模式 → getDevDist() ?? '.faapi'；prod → process.env.FAAPI_DIST ?? 'dist'
  ├─ getRuntimeToolSchemaPath(tool.filePath, dist, rootDir) → zod.js 绝对路径
  ├─ fs.existsSync(zodPath) === false → 返回 undefined（zod.js 不存在，用自由 schema）
  ├─ importWithCacheBust(zodPath, bustViteCache=isDevOnDemandEnabled())
  │    └─ dev 按需模式：走 Node 原生 import + 时间戳 query 绕过 Vite SSR 缓存
  ├─ 提取 mod[`${inputTypeName}Schema`]
  │    ├─ 导出存在 → 返回 { schema, schemaName }
  │    └─ 导出不存在 → 返回 undefined
  └─ import 失败 → 返回 undefined（tool schema 可选，缺失不报错）
```

`rootDir` 参数用于计算 zod.js 绝对路径（`tool.filePath` 是相对路径时拼接 `rootDir`）。

## 与 loadToolModule 的差异

| 维度 | loadToolModule | loadToolSchema |
| --- | --- | --- |
| 加载目标 | handler.js（tool 函数） | zod.js（tool schema） |
| 第二参数 | `functionName`（导出函数名） | 无（schema 名从 `inputTypeName` 推导） |
| 返回类型 | `{ handler, functionName }` | `{ schema, schemaName } \| undefined` |
| 缺失行为 | 抛错（tool 函数必须存在） | 返回 undefined（schema 可选，用自由 schema） |
| dev 按需编译 | `ensureCompiled` 确保 handler.js 编译 | 不触发编译（zod.js 是生成产物，非编译产物） |
| 类型安全 | `handler: (...args) => unknown` | `schema: unknown`（faapi 不依赖 zod） |

## 为什么 schema 缺失返回 undefined 而非抛错

与 route 的 schema 不同（route schema 缺失抛 `InternalError`，不静默放行），tool schema 是**可选的**：

- `@faapi/agent` 的 `AgentDeps.resolveToolSchema` 是可选字段
- 未提供 / tool 无 `inputTypeName` / zod.js 不存在 → 用自由 schema `{ type: 'object' }`，LLM 自由传参
- agent.ts 的 `buildToolDefinitions`：`schemaRes?.jsonSchema ?? { type: 'object' }`

tool input 校验失败不阻断流程——`executeTool` 返回 `{ error }` 对象，reactLoop stringify 后回传 LLM 重试。schema 缺失时 LLM 自由传参，handler 内部自行处理参数合法性。

## 为什么 faapi 核心不依赖 zod

faapi 核心包不声明 zod 为依赖（zod 是 peerDep，业务方自行安装）。`loadToolSchema` 返回 `unknown` 类型的 schema 对象——faapi 核心只负责加载 zod.js 模块（业务方安装的 zod 创建的 schema 对象），类型断言 + `z.toJSONSchema` / `safeParse` 由 `@faapi/agent` 负责（`@faapi/agent` 声明 zod 为 peerDep）。

## dev 按需模式下的 zod.js

dev 按需模式下 tool 的 zod.js 生成时机：
- 启动时：`generateToolArtifacts(skipSchema: true)` 只生成 `faapi-tools.js` 清单，不预生成 zod.js
- 首次请求：由 `ensureToolSchemaGenerated`（阶段 1.4）按需生成单文件 zod.js（与 route 的 `ensureSchemaGenerated` 同构）

`loadToolSchema` 不负责触发 zod.js 生成——只加载已存在的 zod.js。若 zod.js 不存在（`ensureToolSchemaGenerated` 未触发），返回 undefined（用自由 schema）。

## 相关模块

- [loadToolModule](./loadToolModule.md) — 加载 tool handler.js（同构设计参考）
- [importWithCacheBust](../utils/importWithCacheBust.md) — ESM cache bust 加载
- [getRuntimeToolSchemaPath](../cli/generateToolArtifacts.md) — 从 tool.filePath 计算 zod.js 路径
- [compileOnDemand](../cli/compileOnDemand.md) — dev 按需编译核心（`isDevOnDemandEnabled` + `getDevDist`）
- [generateToolArtifacts](../cli/generateToolArtifacts.md) — 上游产出 tool 的 zod.js
- [toolRegistry](../injection/toolRegistry.md) — 调用方，运行时 tool 注册表
