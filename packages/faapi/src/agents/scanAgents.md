# scanAgents

一句话概括：扫描文件系统，生成 agent 清单。**Vite 风格**——仅读源码 + 正则检测 `run` 导出，零 import agent.js，让 dev 启动近乎瞬开。

## 为什么需要

faapi 引入 agent 能力后，需要把目录结构转换为 agent 清单。与 tool 扫描（[scanTools](../tools/scanTools.md)）同构——"文件系统即 agent"，用户在约定目录下写 `handler.ts` 即声明一个 agent，框架自动扫描收集。

旧版（如果用运行时 import 检测导出）会让 dev 启动慢、按需编译无法实现。新版改为：

- **导出检测**：正则匹配源码 `export function run` 等，不 import 模块
- **零 import**：启动时只读源码 + 正则，agent.js 加载延后到 [loadAgentModule](../loader/loadAgentModule.md) 请求阶段（Phase 1.9）

## 使用场景

- `faapi dev` / `faapi build` 启动时扫描 `src/agents/*/handler.ts`
- `reloadAgents` 热替换时重新扫描（dev 模式 watcher 触发，Phase 1.9 接入）
- 根据 glob pattern 过滤 agent 文件
- 将文件路径转换为 agent 名（目录名）

## 文件类型与目录约定

### 目录结构

```
src/
├── api/                            # HTTP 路由（已有）
├── agents/                         # agent 定义
│   └── <agentName>/
│       └── handler.ts              # agent 定义文件（导出 config 块 / run 函数，均可选）
└── tools/                          # tool（跨 agent 复用，由 scanTools 扫描）
    └── <namespace>/handler.ts
```

### 文件名约定

- agent 定义文件名固定为 `handler.ts`（与路由 `handler.ts`、tool `handler.ts` 对称）
- 每个目录下一份 `handler.ts` = 一个 agent
- `*` glob 不跨 `/`，仅匹配 `src/agents/<agentName>/handler.ts`（一级目录）

### agent 名生成规则

agent 名 = `src/agents/` 下的第一级目录名：

| 文件路径 | agent 名 |
|---------|----------|
| `src/agents/researcher/handler.ts` | `researcher` |
| `src/agents/coder/handler.ts` | `coder` |

agent 名可被 JSDoc `@agent` 覆盖（由 [extractAgentMetadata](../ast/extractAgentMetadata.md) 在 AST 阶段处理，Phase 1.8）。

## 导出检测（正则）

scanAgents 检测一个保留导出名：

### run 函数

```ts
const RUN_EXPORT_RE = /export\s+(?:async\s+)?(?:function\s+|const\s+)run\b/;
```

匹配：
- `export function run() { ... }`
- `export async function run() { ... }`
- `export const run = () => { ... }`
- `export const run = async () => { ... }`

不匹配：
- `export const runtime = ...`（`run` 后非词边界）

> 正则检测仅用于扫描阶段快速判断 `run` 导出是否存在。实际 config 块字段提取（systemPrompt / tools / agents / model / maxTurns）由 [extractAgentMetadata](../ast/extractAgentMetadata.md) 在 AST 阶段完成——正则有注释/字符串误匹配的边界情况由 AST 校正。

> **关于 config 导出**：`scanAgents`（正则阶段）不再检测 `config` 导出——`hasConfig` 字段已移除（死链路，详见 [agentTypes](./agentTypes.md)）。但 AST 阶段 [extractAgentMetadata](../ast/extractAgentMetadata.md) 仍会查找 config 导出（用于提取 JSDoc 描述 + config 块字段），两者职责不同：正则阶段仅判断 `run` 是否存在以决定运行时是否加载 `run` 函数，AST 阶段负责把 config 块的字面量字段提取到 `AgentMetadata`。

## 重名检测

同 agent 名出现在多个文件 → `scanAgents` 抛 `AgentConflictError`：

```
Agent conflict: "researcher" declared in both src/agents/researcher/handler.ts and backup/agents/researcher/handler.ts
```

与 [scanTools](../tools/scanTools.md) 的重名检测对称，但 agent 无作用域维度（全局唯一）。

## API

```ts
export async function scanAgents(
  rootDir: string,
  patterns: string[],
): Promise<AgentManifestList>;
```

- `rootDir` — 项目根目录
- `patterns` — glob patterns（默认 `DEFAULT_AGENT_PATTERNS`）

## 相关模块

- [agentTypes](./agentTypes.md) - `AgentManifest` 类型定义
- [scanTools](../tools/scanTools.md) - tool 扫描（同构，扫描 `src/tools/**`）
- [extractAgentMetadata](../ast/extractAgentMetadata.md) - AST 增强 agent 元数据（Phase 1.8）
- [generateAgentArtifacts](../cli/generateAgentArtifacts.md) - 生成 `faapi-agents.js`（Phase 1.9）
- [scanRoutes](../router/scanRoutes.md) - 路由扫描（同构设计参考）
