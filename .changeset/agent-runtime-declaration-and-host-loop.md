---
'@faapi/faapi': major
---

agent 声明运行时化 + 隔离任务 agent 循环收敛宿主（agent-run 单一 RPC）。

**agent 声明运行时化（静态 AST 派发下线）**

- 删除 `ast/extractAgentMetadata`（含 .md/测试）——agent 元数据不再由构建期 AST 字面量提取，改为启动期运行时求值：`agents/loadAgents.ts` 从定位清单（`AgentManifest[]`，由 `scanAgents` 扫描文件系统产出）逐个动态 import handler 求值 `config` 导出并校验
- `AgentCore`/`AgentMetadata`/`AgentDeclaration`/`SystemPromptFactory` 迁入 `agents/agentTypes.ts` 并放宽：`systemPrompt` 支持 `string | SystemPromptFactory`（工厂每次 run 求值）；`reminders` 收完整 `ReminderSpec[]`（string=once / 函数=everyTurn / `{ when, content }` 显式声明）；`tools`/`agents`/`vars`/`maxTurns`/`description` 等启动期注册时一次求值
- handler.ts 统一 `export const config satisfies AgentDeclaration`；检测到自定义 `run` 导出在启动期求值阶段抛迁移错误（编排场景注册 tool）；`hasConfig`/`hasRun`/`AgentPathMeta` 字段与类型删除；`AgentMetadata.inputTypeName` 放宽为 `string`
- `generateAgentArtifacts` 重写：输入 `AgentManifest[]` 产出定位清单 faapi-agents.js + 对声明顶层 `interface Input`/`type Input` 的 agent 生成 zod.js（构建期正则检测）；manifestLoader/dev/build/createDevApp/agentTestHarness 全部切换到新管线

**隔离 worker agent 通道：单次 agent-run RPC（循环收敛宿主）**

- 删除 `AgentToolRunner`（6 方法接口）与 `AgentToolRunnerStore`，新增 `AgentRunner`（单 `runAgent(ctx, request)` 方法）+ `AgentRunRequest`（`{ agentName, input?, options? }`）+ `AgentRunnerStore`；`AppRegistries.agentToolRunner` → `agentRunner`——agent 不再静态派发，由 `@faapi/agent` 插件 setup 时注册使用
- RPC 协议收敛：旧 6 种 per-behavior `agent-call`/`agent-result`（kind 分派）→ 单一 `{ type: 'agent-run', seq, agentName, input, options }` → `{ type: 'agent-run-result', seq, ok, value | error }`。编排循环（LLM IO、tool 执行、钩子、reminders、sub-agent）全在宿主执行——db 连接池等资源单实例、业务函数零跨线程；worker 内 `taskCtx.agent` 只是 run-only 转发代理（`workerEntry.buildAgentRunProxy`，前置校验 options.agent 必填 / provider 实例拒绝 / 不可克隆报错；`buildAgentRpc`/`buildAgentChannel` 删除）
- 注册表快照：`TaskRegistriesSnapshot.agents` 为 `AgentSnapshotRecord[]`（`AgentMetadata` 的可克隆投影：reminders 整体剥离、工厂形态 systemPrompt 剥离），投影单一实现 `toAgentSnapshotRecord`（taskQueue 快照与测试共用）；`TaskQueueDeps.agentToolRunner` → `agentRunner`
- 双形态 input 语义：字符串 = user 消息直传（与 HTTP/编程式 run 同语义，不走派发校验）；对象 = 富派发形态（声明 `Input` 的 agent 在宿主经 zod.js 校验，失败抛 `AgentError` 经 RPC ok:false 以任务错误浮出，校验后经 `extractSubAgentUserInput` 构造 user 消息）
- `IsolatedTaskContext.agent` 增强为 `AgentRpcHandle`（run-only，无 stream/asTool）；`TaskContext.agent`（AgentHandle）不变；`TaskWorkerOptions` 删 `rootDir`；`onAgentCall` → `onAgentRun`

**隔离任务 taskCtx.llm 收敛为 RPC 纯转发（worker 零 @faapi/agent 依赖）**

- 删除 `TaskQueueDeps.llms`（agent.llms 快照下发）与 `workerEntry.buildLlmChannel`（worker 内动态加载 `@faapi/agent` 重建通道）——worker 纯转发原则贯彻到一次性补全：`taskCtx.llm.complete` 经单次 `{ type: 'llm-complete', seq, input, options }` 消息回传宿主，宿主从 `AppRegistries.llm` 取派发时刻注册的通道执行（LLM IO 全在宿主，与 agent 循环同一份 providers/重试引擎），以 `{ type: 'llm-result', seq, ok, value | error }` 回传
- `workerEntry.buildLlmProxy`（纯函数，单测直接构造）：options 前置校验——`onFailure` 钩子为函数不可跨线程显式拒绝（指引任务内 try/catch）；`options.signal` 剥离后转发，业务级取消经 `{ type: 'llm-abort', seq }` 回传宿主 abort 对应请求（宿主侧 AbortController 由执行器注入；与任务取消是两回事——任务取消不传播宿主，挂起调用随两段式取消一并终止）
- `TaskWorkerOptions`：删 `agentModuleUrl`/`llms`，新增 `onLlmComplete`（语义层注入，llm store 未注册时 run 消息不带 `llmChannel`，worker 内 `taskCtx.llm` 不挂载——能力不存在非降级）；`WorkerEntryData` 删 `agentModuleUrl`
- 取消语义固化（显式设计决策）：隔离任务取消只在 worker 侧生效——两段式取消不向宿主 agent-run 循环传播，宿主已开始的循环继续执行到自然结束、结果随 worker 终止被丢弃
