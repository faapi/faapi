# generateAgentArtifacts

一句话概括：从 `AgentManifest[]`（定位清单）生成 `faapi-agents.js` 产物 + 声明 `Input` 的 agent zod.js——正则检测 Input 导出、命中者走共享 schema 管线，config 块字段不再出现在清单里（运行时启动期由 [loadAgents](../agents/loadAgents.md) 动态求值）。

## 为什么需要

agent 声明运行时化后，构建期与运行时的分工是「静态事实进清单、声明数据运行时求值」：

- `name` / `filePath` 是扫描期可定的静态事实——运行时需要它们定位并 import handler 模块
- `inputTypeName` 必须由清单携带——TS 类型编译期擦除，运行时无法从 handler.js 反射「是否声明了 `Input`」；它是 `@faapi/agent` sub-agent 富 schema 派发的运行时判据。prod 运行时只有 dist 产物、无法重扫 src，清单因此保留（与 faapi-routes.js / faapi-tools.js 同构：只携带扫描期事实，不含声明数据）
- config 块字段（systemPrompt / tools / agents / vars / maxTurns / description 等）**不再 AST 提取**——AST 只能拿字面量，函数声明（systemPrompt 工厂、reminders builder）无法跨构建期存活。它们由运行时启动期动态 import handler 模块求值，见 [loadAgents](../agents/loadAgents.md)

`Input` 检测属于类型→zod 通用 schema 域（与 tool 第一参类型提取同构），不在「config 块提取下线」范围内——删除 `inputTypeName` 即静默降级为自由文本交接单。

## 使用场景

- `devCommand` 启动时经 `generateAgentArtifactsForDev` 调用 → `.faapi/faapi-agents.js` + zod.js
- `buildCommand` 构建时调用 → `dist/faapi-agents.js` + zod.js
- `createDevApp.reloadAgents` 热替换时重新生成（watcher 触发）
- `createAgentTestHarness`（`free-form` 模式传 `skipSchema: true`，仅生成定位清单）

## 产物

### faapi-agents.js（定位清单）

```js
// 自动生成,请勿手动编辑(faapi build/dev 产物)
export const agents = [
  {
    "name": "researcher",
    "filePath": "dist/agents/researcher/handler.js",
    "inputTypeName": "Input"
  }
];
```

- `filePath` 经 [toProdFilePath](../utils/prodPaths.md) 转产物形式（`src/agents/researcher/handler.ts` → `dist/agents/researcher/handler.js`，dev 为 `.faapi/...`）——运行时启动期动态 import 定位用
- `inputTypeName` 仅在 handler.ts 检测到顶层 `Input` 导出时写入（值恒为 `'Input'`）
- `writeAgentsModule` 用 `JSON.stringify` 嵌入保证转义安全 + `atomicWriteFile` 原子写（与 routes/tools 清单一致）

### zod.js（仅声明 `Input` 的 agent）

Input 检测用正则 `/^\s*(?:export\s+)?(?:interface|type)\s+Input\b/m`（行首锚定 + 词边界，与 tool 的函数名正则提取同款零 AST 预过滤策略）。命中者才建 TS Program：

```
AgentManifest[] (scanAgents, 仅定位字段)
    ↓ generateAgentArtifacts
    ├─ 正则检测 Input → 命中者 createPrograms + extractTypeInfo(program, file, 'Input')
    │     ↓ generateZodArtifacts 共享管线（coerce=false）
    │   <dist>/agents/<name>/zod.js（导出 InputSchema）
    └─ SerializedAgentRecord[] → writeAgentsModule → <dist>/faapi-agents.js
```

- zod.js 导出 `${inputTypeName}Schema`（即 `InputSchema`），与 handler.js 同级
- `coerce=false`——入参来自 LLM JSON 调用，与 tool/task 同语义
- 类型提取失败（不合法类型引用）由 `extractTypeInfo` 内部抛 `SchemaExtractionError`，与 tool 管线同语义

**dev/prod 同路径全量生成**，不引入 tool 式按需生成。理由：agent 数量级小（十位数）且 Program 仅对命中 Input 的文件创建，全量生成的边际成本可忽略；而「声明了 `Input` 但 zod.js 缺失」若走按需生成，运行时无法区分「尚未生成」与「产物损坏」，schema 会静默退回单字段模式——全量生成让该场景只剩产物异常一种可能，`@faapi/agent` 侧对它显式抛错（见 [agent](../../../agent/src/agent.md)「派发入参 schema 声明」）。

未声明 `Input` 的 agent 不生成 zod.js、清单无 `inputTypeName`——运行时保持单字段 `input` 交接单模式。

`options.skipSchema`（默认 false）跳过 zod.js 生成，**仅供不入产物的测试设施**（`createAgentTestHarness` 的 `free-form` 模式）使用——该模式不提供 schema 解析器，生成的 zod.js 不会被任何路径读取。dev/build 管线不传此选项（语义：声明了 `Input` 即必须有产物，「跳过生成」在产物流水线上是静默降级）。

## 运行时消费

```
faapi-agents.js
    ↓ loadAndEvaluateAgents（importWithCacheBust 加载清单——清单和 handler 都 bust）
    ↓ 逐条动态 import handler → 求值 config 导出 + 校验（错误带 agent 名与 filePath）
AgentMetadata[] → agentRegistry
```

清单级的跨 agent 校验（重名、`agents` 引用不存在）在运行时求值阶段由 [loadAgents](../agents/loadAgents.md) 的 `validateAgentDeclarations` 完成——这些校验跟着声明求值走，不在本模块（构建期不再解析 config 块，自然无从校验）。

## API

| 导出 | 说明 |
| --- | --- |
| `generateAgentArtifacts(agents, rootDir, dist, options?)` | 主入口：Input 正则检测 → 命中者生成 zod.js → 序列化写入 `faapi-agents.js`，返回 `SerializedAgentRecord[]`（供调用方日志/调试）；`options.skipSchema` 仅测试设施 free-form 模式使用 |
| `writeAgentsModule(manifest, outputPath)` | 写入 `faapi-agents.js` ESM 模块（`export const agents = [...]`） |
| `SerializedAgentRecord` | 序列化记录类型：`{ name, filePath, inputTypeName? }`——纯静态事实 |

## 与 generateToolArtifacts 的对比

| 维度 | generateToolArtifacts | generateAgentArtifacts |
| --- | --- | --- |
| 输入 | `ToolManifest[]` | `AgentManifest[]` |
| 预过滤 | 正则提取函数名 | 正则检测 `Input` 类型导出（零 AST，仅命中者建 Program） |
| 清单产物 | `faapi-tools.js`（导出 `tools`，含 description/inputTypeName） | `faapi-agents.js`（导出 `agents`，仅 name/filePath/inputTypeName） |
| zod.js 生成 | 每个 handler 一个（coerce=false） | 仅声明 `Input` 的 agent 生成（共享管线，coerce=false） |
| zod.js 时机 | dev 按需（`skipSchema`）/ prod 全量 | dev/prod 一致全量；`options.skipSchema` 仅供测试设施 |
| 运行时加载 | `loadToolModule`（按 functionName 提取函数） | [loadAgents](../agents/loadAgents.md)（动态 import 求值 config 导出） |

## 相关模块

- [scanAgents](../agents/scanAgents.md) - 扫描 agent 目录产出 `AgentManifest[]`（仅定位字段）
- [loadAgents](../agents/loadAgents.md) - 运行时启动期求值 config 导出 + 校验（清单的消费方）
- [agentTypes](../agents/agentTypes.md) - `AgentManifest` / `SerializedAgentRecord` 关联类型定义
- [createAppCore](./createAppCore.md) - 启动时 `loadAndHydrateAgents` 入口
- [generateZodArtifacts](./generateZodArtifacts.md) - 类型→zod 共享产物管线（zod.js 生成实现）
- [generateToolArtifacts](./generateToolArtifacts.md) - tool 产物生成（对称模块）
