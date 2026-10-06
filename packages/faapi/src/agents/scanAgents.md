# scanAgents

一句话概括：扫描文件系统，生成 agent 清单。**Vite 风格**——仅读源码 + 正则检测 `run` 导出，零 import agent.js，让 dev 启动近乎瞬开。

## 为什么需要

faapi 引入 agent 能力后，需要把目录结构转换为 agent 清单。与 tool 扫描（[scanTools](../tools/scanTools.md)）同构——"文件系统即 agent"，用户在约定目录下写 `handler.ts` 即声明一个 agent，框架自动扫描收集。

旧版（如果用运行时 import 检测导出）会让 dev 启动慢、按需编译无法实现。新版改为：

- **零内容解析**：扫描层不读源码内容，config 块字段提取由 AST 阶段负责
- **零 import**：启动时只读文件列表，不读源码内容、不 import 模块

## 使用场景

- `faapi dev` / `faapi build` 启动时扫描 `src/agents/**/handler.ts`（支持多级嵌套目录，见下文）
- `reloadAgents` 热替换时重新扫描（dev 模式 watcher 触发，Phase 1.9 接入）
- 根据 glob pattern 过滤 agent 文件
- 将文件路径转换为 agent 名（目录名）

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

> 迁移提示：旧版 `/` 规范化为 `.` 且允许段内任意字符（含平铺点号目录 `easy-writing.wizard/`）。新版下嵌套调用名 `easy-writing.wizard` 改为 `easy-writing_wizard`（`agents` 声明、`agent.run({ agent })`、authHooks 前缀判断同步改），平铺点号目录需改名为连字符（`easy-writing-wizard/`）。

agent 名可被 JSDoc `@agent` 覆盖（由 [extractAgentMetadata](../ast/extractAgentMetadata.md) 在 AST 阶段处理，Phase 1.8）——覆盖值须整体匹配 `^[a-zA-Z0-9_-]+$`（无嵌套语义，`_` 可用），违例在 AST 阶段抛错。

## 导出检测（正则）

scanAgents 检测一个保留导出名：

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
- `patterns` — glob patterns（默认 `DEFAULT_AGENT_PATTERNS = ['src/agents/**/handler.ts']`）

## 相关模块

- [agentTypes](./agentTypes.md) - `AgentManifest` 类型定义
- [scanTools](../tools/scanTools.md) - tool 扫描（同构，扫描 `src/tools/**`）
- [extractAgentMetadata](../ast/extractAgentMetadata.md) - AST 增强 agent 元数据（Phase 1.8）
- [generateAgentArtifacts](../cli/generateAgentArtifacts.md) - 生成 `faapi-agents.js`（Phase 1.9）
- [scanRoutes](../router/scanRoutes.md) - 路由扫描（同构设计参考）
