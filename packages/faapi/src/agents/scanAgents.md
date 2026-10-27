# scanAgents

一句话概括：扫描文件系统，生成 agent **定位清单**（`AgentManifest[]`——仅 name / filePath 静态事实）。Vite 风格——只读源码文件列表，零 import agent.js、零内容解析，让 dev 启动近乎瞬开。

## 为什么需要

faapi 引入 agent 能力后，需要把目录结构转换为 agent 清单。与 tool 扫描（[scanTools](../tools/scanTools.md)）同构——"文件系统即 agent"，用户在约定目录下写 `handler.ts` 即声明一个 agent，框架自动扫描收集。本模块只做**定位**（哪个目录是哪个 agent），不做声明解析：

- **零内容解析**：扫描层不读源码内容——config 块字段由启动期运行时求值（[loadAgents](./loadAgents.md) 动态 import handler 求值 `config` 导出），`Input` 类型导出由 [generateAgentArtifacts](../cli/generateAgentArtifacts.md) 构建期正则检测
- **零 import**：启动时只读文件列表，不读源码内容、不 import 模块

## 使用场景

- `faapi dev` / `faapi build` 启动时扫描 `src/agents/**/handler.ts`（支持多级嵌套目录，见下文）
- `reloadAgents` 热替换时重新扫描（dev 模式 watcher 触发，Phase 1.9 接入）
- 根据 glob pattern 过滤 agent 文件
- 将文件路径转换为 agent 名（目录路径推导）

## 文件类型与目录约定

### 目录结构

```
src/
├── api/                            # HTTP 路由（已有）
├── agents/                         # agent 定义
│   ├── <agentName>/
│   │   └── handler.ts              # agent 定义文件（导出 config 块）
│   └── <group>/                    # 可选分组目录（多级嵌套）
│       └── <agentName>/
│           └── handler.ts
└── tools/                          # tool（跨 agent 复用，由 scanTools 扫描）
    └── <namespace>/handler.ts
```

### 文件名约定

- agent 定义文件名固定为 `handler.ts`（与路由 `handler.ts`、tool `handler.ts` 对称）
- 每个目录下一份 `handler.ts` = 一个 agent
- 默认 pattern 为 `src/agents/**/handler.ts`——`**` 匹配零级或多级目录，平铺（一级）与嵌套（多级）均被发现

### agent 名生成规则

agent 名 = `agents/` 之后、`handler.ts` 之前的完整子路径，`/` 规范化为 `_`：

| 文件路径 | agent 名 |
|---------|----------|
| `src/agents/researcher/handler.ts` | `researcher` |
| `src/agents/coder/handler.ts` | `coder` |
| `src/agents/easy-writing/wizard/handler.ts` | `easy-writing_wizard` |
| `src/agents/a/b/c/handler.ts` | `a_b_c` |
| `src/agents/easy-writing.wizard/handler.ts` | ❌ 段 `easy-writing.wizard` 含点，扫描报错 |

**目录段字符集校验**（构建期强制）：每个目录段必须匹配 `^[a-zA-Z0-9-]+$`——即 LLM 工具名允许字符集（`[a-zA-Z0-9_-]`）再排除 `_`。`_` 被 `/` 规范化独占为嵌套分隔符（段内出现 `_` 会让「嵌套」与「段内下划线」不可区分），`.` 与其他字符则会让 agent 名进入派发工具名（`agent-<agentName>`，见 [subAgentToolName](../injection/subAgentToolName.md)）后违反 OpenAI 兼容协议 `^[a-zA-Z0-9_-]+$`，被强校验上游（DeepSeek / OpenAI 等）整单 400。违例段在扫描时显式抛错（含路径与改名指引），不做静默净化：

```
Invalid agent directory segment "easy-writing.wizard" in "src/agents/easy-writing.wizard/handler.ts":
agent directory names allow a-z A-Z 0-9 '-' only ('_' is reserved as the nesting separator) — rename the directory
```

## 重名检测

同 agent 名出现在多个文件 → `scanAgents` 抛错：

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
- `patterns` — glob patterns（默认 `DEFAULT_AGENT_PATTERNS = ['src/agents/**/handler.ts']`）

返回 `AgentManifest[]`（`{ name, filePath }` 定位清单条目，类型见 [agentTypes](./agentTypes.md)）。

## 相关模块

- [agentTypes](./agentTypes.md) - `AgentManifest` / `AgentManifestList` 类型定义
- [loadAgents](./loadAgents.md) - 启动期求值 `config` 导出（含 `run` 导出检测）
- [generateAgentArtifacts](../cli/generateAgentArtifacts.md) - 生成 `faapi-agents.js` 定位清单 + Input zod.js
- [scanTools](../tools/scanTools.md) - tool 扫描（同构，扫描 `src/tools/**`）
- [scanRoutes](../routers/scanRoutes.md) - 路由扫描（同构设计参考）
