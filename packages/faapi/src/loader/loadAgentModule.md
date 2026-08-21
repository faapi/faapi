# loadAgentModule

一句话概括：动态 import `agent.js` 产物并提取 `config` 块和可选的 `run` 函数，供 agent 运行时执行。

## 为什么需要

`faapi-agents.js` 中的 `AgentMetadata` 仅含 AST 阶段提取的**字面量**字段（systemPrompt / tools / agents / model / maxTurns）。但 config 块可能含**运行时动态求值**的字段（如 `process.env.API_KEY`、函数引用、运行时计算值），这些无法在编译期 AST 提取。

`loadAgentModule` 在运行时按需 import `agent.js`，拿到完整 config 对象（含动态字段）和 `run` 函数引用，供：

- `@faapi/agent` 子包的 `Agent` 类（Phase 3.x）读取 config 覆盖默认值
- `Agent.run()` 调用自定义 `run` 函数替代默认 reactLoop

## 使用场景

- agent 执行入口（Phase 2.x `agentRegistry` / Phase 3.x `Agent` 类）按 `filePath` + `hasConfig` + `hasRun` 加载
- dev 按需编译模式：首次执行 agent 时触发 `ensureCompiled` → import
- prod 模式：产物已固化，直接 import

## 设计

### 与 loadToolModule 的对称与差异

| 维度 | loadToolModule | loadAgentModule |
| --- | --- | --- |
| 提取目标 | 单个函数（`functionName`） | `config` 对象 + 可选 `run` 函数 |
| 校验 | handler 必须为 function | config 为 object 或 function（返回 object）；run 为 function |
| 函数形式处理 | 不适用 | config 为 function 时自动调用拿到返回值 |
| 导出名 | `functionName`（动态） | 固定 `config` / `run` |
| 返回 | `{ handler, functionName }` | `{ config, run }` |

### config 函数形式自动调用

`export function config() { return {...} }` / `export const config = () => ({...})`：

- AST 阶段（[extractAgentMetadata](../ast/extractAgentMetadata.md)）从 return 表达式提取字面量字段
- 运行时（本模块）调用 `config()` 拿到完整返回值（含动态字段）

无参调用——config 函数不应依赖参数（动态字段从 `process.env` / 闭包等读取）。

### Dev 按需编译

与 `loadRouteModule` / `loadToolModule` 同构——dev 按需模式下先 `ensureCompiled` 确保产物存在再 import，避免 import 不存在的文件污染 Vite SSR 内部状态。prod 模式直接 import，失败即报错。

详见 [loadRouteModule](./loadRouteModule.md) 的"Dev 按需编译"章节，本模块复用同一套 `ensureCompiled` + `importWithCacheBust` 机制。

## API

| 导出 | 说明 |
| --- | --- |
| `loadAgentModule(filePath, hasConfig, hasRun, rootDir?)` | 主入口：按需 import + 提取 config/run |
| `AgentModule` | 返回类型 `{ config?, run? }` |

## 错误处理

- 编译失败 → 抛 "Failed to compile agent module"
- import 失败 → 抛 "Failed to load agent module"
- `hasConfig=true` 但 config 导出缺失 → 抛 "does not export config"
- config 函数返回非对象 → 抛 "config() did not return an object"
- config 既非对象也非函数 → 抛 "config export must be an object or function"
- `hasRun=true` 但 run 不是 function → 抛 "does not export a valid run function"

## 相关模块

- [loadToolModule](./loadToolModule.md) - tool 模块加载（对称模块）
- [loadRouteModule](./loadRouteModule.md) - 路由模块加载（按需编译机制来源）
- [resolveExports](./resolveExports.md) - 导出解析（具名 + 默认导出对象属性）
- [compileOnDemand](../cli/compileOnDemand.md) - `ensureCompiled` 按需编译 + mtime 缓存
- [importWithCacheBust](../utils/importWithCacheBust.md) - ESM import 缓存绕过
- [extractAgentMetadata](../ast/extractAgentMetadata.md) - `AgentMetadata` 字面量提取（运行时前的编译期阶段）
- [agentRegistry](../injection/agentRegistry.md) - 调用方（按 `filePath` + `hasConfig` + `hasRun` 加载）
