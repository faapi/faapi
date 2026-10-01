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

agent 名 = `agents/` 之后、`handler.ts` 之前的完整子路径，`/` 规范化为 `.`：

| 文件路径 | agent 名 |
|---------|----------|
| `src/agents/researcher/handler.ts` | `researcher` |
| `src/agents/coder/handler.ts` | `coder` |
| `src/agents/easy-writing/wizard/handler.ts` | `easy-writing.wizard` |
| `src/agents/a/b/c/handler.ts` | `a.b.c` |

规范化为 `.` 而非保留 `/`，与运行时命名约定一致：`asTool` 生成的工具名本身是 `agent.<agentName>`（见 [registries](../injection/registries.ts)），agent 调用入口 `agent.run(input, { agent })` 与 sub-agent 的 `agents` 列表均按名查表，点号名可读性更好且与既有平铺点号目录（`easy-writing.wizard/`）的调用名完全兼容。

agent 名可被 JSDoc `@agent` 覆盖（由 [extractAgentMetadata](../ast/extractAgentMetadata.md) 在 AST 阶段处理，Phase 1.8）。

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
