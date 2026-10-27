# scanTools

一句话概括：扫描文件系统，生成 tool 清单。**Vite 风格**——仅读源码 + 正则提取函数导出名，零 import tool.js，让 dev 启动近乎瞬开。

## 为什么需要

faapi 引入 agent 能力后，需要把目录结构转换为 tool 清单。与路由扫描（[scanRoutes](../routers/scanRoutes.md)）同构——"文件系统即 tool"，用户在约定目录下写 `handler.ts` 导出函数即声明一个 tool，框架自动扫描收集。

所有 tool 统一放在 `src/tools/` 下，跨 agent 复用，agent 通过 `tools` 显式声明可用 tool（见 [agentRegistry](../injection/agentRegistry.md) 的 `resolveAgentTools`）。

函数名提取不走运行时 import——那会让 dev 启动慢、按需编译无法实现。因此：

- **函数名提取**：正则匹配源码 `export function <name>` / `export const <name> = ...`，不 import 模块
- **零 import**：启动时只读源码 + 正则，tool.js 加载延后到 [loadToolModule](../loaders/loadToolModule.md) 请求阶段（详见 [compileOnDemand](../cli/compileOnDemand.md)）

## 使用场景

- `faapi dev` / `faapi build` 启动时扫描 `src/tools/**/*.ts`
- `reloadTools` 热替换时重新扫描（dev 模式 watcher 触发）
- 根据 glob pattern 过滤 tool 文件
- 将文件路径转换为 tool 名（子目录作为命名空间）

## 文件类型与目录约定

### 目录结构

```
src/
├── api/                            # HTTP 路由（已有）
├── agents/                         # agent 定义
│   └── <agentName>/
│       └── handler.ts              # agent 定义文件
└── tools/                          # tool（跨 agent 复用）
    └── <namespace>/handler.ts
```

### 文件名约定

- tool 文件名固定为 `handler.ts`（与路由 `handler.ts` 对称）
- 文件内的所有 `export function` / `export const =` 函数声明都识别为 tool（一个文件可声明多个 tool）
- 排除保留导出名：`default` / `config` / `run`（agent 系统保留，非 tool）
- 预留函数名 `handler`：识别为 tool，但函数名不拼进 tool 名（tool 名即命名空间，见下文）

## 函数导出识别（正则）

`TOOL_EXPORT_RE` 匹配源码中导出的函数名（任意合法标识符，区别于路由的固定 HTTP 方法名）：

```ts
const TOOL_EXPORT_RE = new RegExp(
  String.raw`export\s+(?:async\s+)?(?:function\s+|const\s+)([A-Za-z_$][\w$]*)\s*(?:\(|=)`,
  'g',
);
```

支持语法：

- `export function getWeather(input) {}`
- `export async function getWeather(input) {}`
- `export const getWeather = (input) => {}`
- `export const getWeather = async (input) => {}`

不匹配：

- `export interface WeatherInput {}`（interface 关键字）
- `export type X = ...`（type 关键字）
- `export { getWeather }`（命名导出引用，非声明）
- `export default ...`（default 保留名）

排除保留导出名（即使匹配正则也不识别为 tool）：

- `default` — 默认导出保留
- `config` — agent 配置块（[scanAgents](./scanAgents.md) 使用）
- `run` — agent 自定义运行函数（[scanAgents](./scanAgents.md) 使用）

## tool 命名规则

tool 名 = `子目录_函数名`，子目录作为命名空间前缀，目录段之间与命名空间和函数名之间都用 `_` 连接：

| 文件路径 | 函数名 | tool 名 |
|---------|--------|---------|
| `src/tools/weather/handler.ts` | `getWeather` | `weather_getWeather` |
| `src/tools/handler.ts` | `getWeather` | `getWeather` |
| `src/tools/a/b/handler.ts` | `deep` | `a_b_deep` |

命名空间生成规则：

1. 去掉文件路径前缀 `src/tools/`
2. 去掉文件名（`handler.ts`）
3. 剩余路径段（非空时）用 `_` 连接，作为命名空间
4. tool 名 = 命名空间 + `_` + 函数名；无子目录时纯函数名

### 预留函数名 `handler`（函数名不拼名）

`handler` 是命名空间独占的预留函数名——识别为 tool，但函数名不拼进 tool 名，tool 名即命名空间本身，目录表达「一个能力一个 tool」的语义单元。命名与文件名 `handler.ts` 呼应（「目录 = 能力，handler.ts = 实现，handler 函数 = 本体」），并与路由侧对称（`src/api/<path>/handler.ts` 导出方法函数，URL 只看目录）：

| 文件路径 | 函数名 | tool 名 |
|---------|--------|---------|
| `src/tools/weather/handler.ts` | `handler` | `weather` |
| `src/tools/a/b/handler.ts` | `handler` | `a_b` |
| `src/tools/weather/handler.ts` | `getWeather` | `weather_getWeather`（普通函数不受影响） |

- `handler` 与同文件其他函数可共存（如同时导出 `handler` 与 `getWeather` → `weather` + `weather_getWeather`）
- `functionName` 仍为 `handler`——AST 提取（[extractToolMetadata](../ast/extractToolMetadata.md)）与运行时函数定位（`loadToolModule`）语义不变
- 无命名空间时（`src/tools/handler.ts` 导出 `handler`）合成名为空串，扫描期显式抛错（不回退为函数名——「函数名不拼名」语义下 `handler` 作 tool 名无意义），报错含挪入子目录指引
- `handler` 合成名与其他 tool 名冲突时走全局重名检测抛错（如根级 `export function weather` 与 `src/tools/weather/handler.ts` 的 `handler` 同名）

**字符集校验**（构建期强制，与 [agent 目录段](../agents/scanAgents.md)同规则）：

- 每个目录段必须匹配 `^[a-zA-Z0-9-]+$`——LLM 工具名字符集（`[a-zA-Z0-9_-]`，OpenAI 兼容协议对 `function.name` 的硬约束）再排除 `_`（`_` 被 `/` 规范化独占为嵌套分隔符，段内出现会让嵌套与段内下划线不可区分）
- 合成的 tool 名整体必须匹配 `^[a-zA-Z0-9_-]+$`——函数名含 `$` 等非法字符（如 `export const $fetch`）时抛错
- 违例在扫描时显式抛错（含路径与改名指引），不静默净化——非法名字发给强校验上游（DeepSeek / OpenAI 等）整单 400

### 重名检测

- 全局同名 tool → `scanTools` 抛 `ToolConflictError`

设计意图：tool 名全局唯一，agent 通过 `tools` 显式声明引用，无需作用域隔离。

## 相关模块

- `parseToolFile.ts` - tool 文件路径解析（命名空间生成）
- `toolTypes.ts` - `ToolManifest` 类型定义（含 `functionName` 字段，供 AST 提取定位函数）
- `TOOL_PATTERNS` - 扫描 patterns（`src/tools/**/*.ts`，框架约定非用户可配置项），由 devCommand / buildCommand / createDevApp.reloadTools 共享
- [scanRoutes](../routers/scanRoutes.md) - 路由扫描（同构设计参考）
- [scanAgents](./scanAgents.md) - agent 扫描（与 tool 扫描对称）
- [extractToolMetadata](../ast/extractToolMetadata.md) - 消费 `functionName` 在源文件中提取 JSDoc/参数类型
- [generateToolArtifacts](../cli/generateToolArtifacts.md) - 生成 `faapi-tools.js` 清单 + zod schema
- [loadToolModule](../loaders/loadToolModule.md) - 按需 import tool.js
- [compileOnDemand](../cli/compileOnDemand.md) - dev 按需编译模式（依赖 scanTools 的零 import 特性）
