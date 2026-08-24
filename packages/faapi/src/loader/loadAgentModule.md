# loadAgentModule

一句话概括：动态 import `agent.js` 产物并提取可选的 `run` 函数，供 agent 运行时执行。

## 为什么需要

`faapi-agents.js` 中的 `AgentMetadata` 已含 AST 阶段提取的**字面量**字段（systemPrompt / tools / agents / model / maxTurns），足以覆盖 80% 的"配置 + tool 组合"场景。

`loadAgentModule` 在运行时按需 import `agent.js`，拿到 `run` 函数引用，供 `Agent.run()` 调用自定义 `run` 函数替代默认 reactLoop（多步 prompt 串联场景）。

> `config` 字段已移除——`AgentModule.config` 原本用于运行时拿到完整 config 对象（含动态字段），但 `executeSubAgent` 拿到 `mod.config` 后从不读取（run 函数在自己模块内直接引用 config 变量），属于死链路，故移除。config 块字段的字面量提取仍由 [extractAgentMetadata](../ast/extractAgentMetadata.md) 在 AST 阶段完成。

## 使用场景

- agent 执行入口（Phase 2.x `agentRegistry` / Phase 3.x `Agent` 类）按 `filePath` + `hasRun` 加载
- dev 按需编译模式：首次执行 agent 时触发 `ensureCompiled` → import
- prod 模式：产物已固化，直接 import

## 设计

### 与 loadToolModule 的对称与差异

| 维度 | loadToolModule | loadAgentModule |
| --- | --- | --- |
| 提取目标 | 单个函数（`functionName`） | 可选 `run` 函数 |
| 校验 | handler 必须为 function | run 为 function（`hasRun` 为 true 时校验） |
| 导出名 | `functionName`（动态） | 固定 `run` |
| 返回 | `{ handler, functionName }` | `{ run }` |

### Dev 按需编译

与 `loadRouteModule` / `loadToolModule` 同构——dev 按需模式下先 `ensureCompiled` 确保产物存在再 import，避免 import 不存在的文件污染 Vite SSR 内部状态。prod 模式直接 import，失败即报错。

详见 [loadRouteModule](./loadRouteModule.md) 的"Dev 按需编译"章节，本模块复用同一套 `ensureCompiled` + `importWithCacheBust` 机制。

## API

| 导出 | 说明 |
| --- | --- |
| `loadAgentModule(filePath, hasRun, rootDir?)` | 主入口：按需 import + 提取 run |
| `AgentModule` | 返回类型 `{ run }` |

## 错误处理

- 编译失败 → 抛 "Failed to compile agent module"
- import 失败 → 抛 "Failed to load agent module"
- `hasRun=true` 但 run 不是 function → 抛 "does not export a valid run function"

## 相关模块

- [loadToolModule](./loadToolModule.md) - tool 模块加载（对称模块）
- [loadRouteModule](./loadRouteModule.md) - 路由模块加载（按需编译机制来源）
- [resolveExports](./resolveExports.md) - 导出解析（具名 + 默认导出对象属性）
- [compileOnDemand](../cli/compileOnDemand.md) - `ensureCompiled` 按需编译 + mtime 缓存
- [importWithCacheBust](../utils/importWithCacheBust.md) - ESM import 缓存绕过
- [extractAgentMetadata](../ast/extractAgentMetadata.md) - `AgentMetadata` 字面量提取（运行时前的编译期阶段）
- [agentRegistry](../injection/agentRegistry.md) - 调用方（按 `filePath` + `hasRun` 加载）
