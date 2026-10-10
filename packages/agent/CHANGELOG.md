# @faapi/agent

## 6.38.0

### Minor Changes

- cd690b6: 新增历史压缩（compaction）能力——策略位 + 可选现货组件：

  - **策略位**：`ReactLoopConfig` / `AgentRuntimeConfig` 新增 `historyCompactor`——`maxHistoryTokens` 超预算且存在轮组时改调业务压缩策略（整体替换现行截断），仅作用于发送副本（`result.messages` 与续跑源不受影响）；子代理递归共享根 deps 全树生效。输出不变量由框架强制守卫（system 与初始 user 头部段必须保留 / `tool_calls` 与 tool 结果按 `tool_call_id` 配对完整 / 至少保留一个轮组），违反抛 `AgentError` 不静默。缺省不声明时逐字节保持现行「按轮组从最旧截断」行为
  - **现货组件**：`createRollingSummaryCompactor`——滚动摘要折叠配方（`plan` 折叠计划 / `fold` 摘要合并 / `block` 注入块四件套纪律文案），`complete` 接轻量补全签名；保留条数 / 折叠批次 / 摘要长度 / 提示词全文 / 轮次格式全部可覆盖，组件无状态（折叠状态存储留业务表设计），与策略位正交不自动接线

  内部重构：`AgentError` / `AgentRecursionError` / `AgentToolTimeoutError` 迁至 `agentErrors.ts`（reactLoop 的不变量守卫需要抛 `AgentError`，独立模块解循环依赖），经 agent re-export——`from '@faapi/agent'` 导入路径零变化。

## 6.37.0

### Minor Changes

- 9ca861c: 新增 `AgentDeps` 官方装配工厂 `createAgentDeps`（`@faapi/agent` 导出）——任务内组装 agent / 自组装场景不再逐字段复刻插件工厂的访问器拼装。

  - `createAgentDeps({ registries, ctx?, rootDir?, llms?, config?, overrides? })`：从注册表视图 + llms 配置构造完整 `AgentDeps`——注册表访问器透传、`loadToolModule` 桥接、schema 解析器（同一实例服务 tool input 与派发入参）、llms → providers 转换；差异项（`resolveSystemPrompt` 装饰、schema 富化、providers 直传等）经 `overrides` 浅合并叠加
  - `registries` 参数取最小结构——`ctx.registries`（AppRegistries）、`taskCtx.registries`（只读视图）、测试设施 `harness.registries` 三种来源均可直传
  - 纯装配无副作用：providers Map 与 schema 解析器缓存随 deps 生命周期，进程级复用由调用方负责（插件 setup 调一次天然单例；任务侧建议模块级创建）
  - `@faapi/agent` 插件 setup 改经本工厂装配（与任务侧单一实现，行为不变：providers/schema 缓存仍为 setup 闭包级跨请求复用）；空 apiKey 的启动期显性提示保留在插件

- 80e1f4f: 新增 agent 流程测试设施 `createAgentTestHarness`（`@faapi/faapi/testing` 导出）与官方脚本假 LLM `createScriptLLM`（`@faapi/agent` 导出）——agent 流程测试（真 reactLoop + 真工具 + 假 LLM）不再需要每项目手搓注册表桩。

  - `createAgentTestHarness({ rootDir, schemaMode? })`：测试进程内扫描 agent/tool 源码（与 dev 启动同管线，`@agent`/`@tool` 覆盖名生效），现场编译 tool 源码闭包到临时目录（不依赖 build 产物），水合出与生产同接口的注册表视图（`registries`）+ 可拼装 `AgentDeps` 的 `loadToolModule` 桥接 + `agentNames`/`toolNames` 清单；`close()` 幂等清理。不建 app——单进程单 app 零占用
  - `schemaMode: 'generated'`（默认 `'free-form'`）现场生成 zod.js 并按生产口径校验工具/派发入参（harness 直接提供 `resolveToolSchema` / `resolveAgentInputSchema`）
  - `createScriptLLM(turns)`：按序回放预设回合、快照每轮完整请求、脚本用尽再被调用即抛错——作 `agent.run(input, { provider })` 注入，子代理递归共享同一游标
  - 配套内部迁移（对业务方导入路径无影响）：`createToolSchemaResolver` 与 `ToolSchemaResolution` 类型从 `@faapi/agent` 下沉主包 loader 域（zod peer 同源，`@faapi/agent` re-export 兼容）；`loadToolSchema` / `getToolSchemaPath` / `createToolSchemaResolver` 新增可选 `dist` 参数（显式产物目录，缺省走 dev on demand / `FAAPI_DIST` 全局解析，行为不变）；`generateAgentArtifacts` 新增 `skipSchema` 选项（仅供测试设施使用，dev/build 管线不传）

## 6.36.0

### Minor Changes

- a67f826: `AgentDeps` 新增可选 `resolveSystemPrompt(name, meta, base)` 装饰钩子——systemPrompt 的解析 seam：框架解析好 base（内联字面量或 `systemPromptFile` 文件内容，语义与现状一致）后调用，返回值即最终 system 消息。组装层得以在框架解析结果之上叠加应用层装饰（共享协议块 / 条件块 / DB 运行时层），替代「包装 `getAgent` / `resolveSubAgents` 访问器 + 预读文件建快照 + 剥除 `systemPromptFile` 声明」三件套机械。每次 run / 派发各调用一次（与文件直读同款新鲜度）；sub-agent 递归复用同一 deps，一次注入覆盖主控与全部可达子代理；钩子抛错原样上抛不吞；base 不可读仍抛 `AgentError`（钩子不被调用）；未声明钩子 = 逐字节现状。框架工厂路径（`@faapi/agent` 插件）暂不透传此钩子，需要装饰的场景走编程式组装（`new Agent(deps)`）。

## 6.35.0

## 6.34.0

## 6.33.0

### Minor Changes

- e6b0258: feat: 框架禁降级——全部降级路径改为显式失败

  维护者决策：框架不允许降级，降级不区分严重程度（辅助信息丢失、可选能力缺席、物理约束受限都不构成降级理由）；暂不支持的场景显式抛错（fail fast + 可行动的错误信息）。禁令已移入 AGENTS.md「5.6.4 禁止降级」，原项目根 `fallback.md` 台账（含隔离任务 config 待决条目）全部处置后删除。

  破坏性变更（按 minor 发版留痕）：

  - `llm.complete` 删除 `fallback` 选项（公开 API 删除）——传输失败（重试耗尽）恒抛 `LLMProviderError`，需要降级语义的调用方在业务侧 try/catch 自行实现（降级是业务决策，不由框架代劳）；`onFailure` 留痕钩子保留，自身抛错改为 `console.error` 留痕（原为静默忽略）

  行为变更（旧降级行为改为显式失败）：

  - 任务 payload：`run` 首参类型声明必填（缺失构建期抛错；确无入参契约显式声明 `type Payload = unknown` 生成恒通过的 `z.unknown()` schema）；运行时 zod.js 缺失/无 `*Schema` 导出抛错，不再静默放行
  - 任务 meta：声明了字段但值非字面量（如 `timeoutMs: 30 * 60_000`）从「警告后忽略」改为构建期抛错；块注释行（`*` / `/*` 开头、终止符结尾）不再误报
  - 隔离任务：错误 props 含不可克隆值从「丢弃 props 保底」改为任务显式失败（错误信息含原 name/message 与修复指引）；日志 fields 不可克隆从「丢弃 fields 输出 warning 标记」改为按执行错误处理（与 progress 同语义）；`agent.llms` 已配置但 `@faapi/agent` 不可解析从「warn + undefined」改为显式抛错（含安装指引）
  - 中间件：模块加载/校验失败（import 失败、导出形态非法、项非函数）从「console.error + 空 bundle」改为显式抛错——命中路由请求 500（onError 可感知），dev watcher 修复后自愈；dev 按需编译失败同样冒泡
  - 插件：任一插件失败从「console.error 汇总后继续启动」改为聚合抛错（`createAppBase` 启动失败、listen 不执行）；重复声明从「warn 跳过」改为记入失败
  - 日志：fields 序列化对齐框架统一出口 `stringifyJson`（BigInt 原抛错、Map/Set/RegExp/NaN 原静默丢数据，现全部正确输出可逆原生表示）；循环引用等结构错误抛 `TypeError` 冒泡（「日志调用永不抛错」契约废除）；文件 sink 流错误（磁盘满等）从完全静默改为每流首次 `console.error` 留痕
  - 钩子留痕：lifecycle `onError` / 任务 `onFailed` 自身抛错从静默吞掉改为 `console.error` 留痕
  - 隔离任务 config：删除 `safeConfig` JSON 快照降级——**隔离任务（声明 timeoutMs）的 `ctx.config` 为 `undefined`**，worker 线程不接收进程配置（config 含函数字段不可结构化克隆，不做降级传递）；任务数据经 payload 显式传入（调用方 `tasks.enqueue(name, { db: ctx.config.db })`）。进程内任务不变：`ctx.config` 为活引用全量配置，类型从 `unknown` 收紧为 `FaapiContextConfig`（声明合并增强与 handler `ctx.config` 同源同型）。
  - 上下文类型显式分开：新增 `IsolatedTaskContext`（隔离任务上下文，**无 config 字段**——访问即编译错误；registries/log/progress 的快照与克隆约束写在字段文档）。`TaskContext`（进程内）config 恢复必有——进程内恒有活引用。`TaskModule.run` 签名为两类型联合，业务按执行路径标注对应类型，边界编译期可见
  - 内部 config plumbing 类型对齐：`createServer`/`handleWsUpgrade` options 与错误响应格式化链路的 config 参数从 `Record<string, unknown>` 收紧为 `FaapiContextConfig`（与 `ctx.config` 同型；业务若以 `Record<string, unknown>` 变量传入需适配，对象字面量不受影响）

## 6.32.0

### Minor Changes

- 4be5a61: feat: 轻量 LLM 补全通道——agent 循环之外的一次性补全官方出口

  @faapi/agent 新增 `createLightComplete`（并由插件自动注册）：字符串进字符串出，复用 `agent.llms` 同源配置与 provider 重试引擎（指数退避 / Retry-After / 429·5xx 判定），默认 60s 超时，失败钩子 `onFailure` 与降级值 `fallback` 内建（可降级不可静默——fallback 命中且未声明钩子时框架兜底 warn）。model key 解析与 `agent.run` 同规则（llms key / provider/model / 纯 model 名）。

  接入点：handler 新增 `llm` 注入参数（类型 `LlmComplete` 从 `@faapi/agent` 导入，插件未加载时 `undefined`）；任务侧 `taskCtx.llm` 双路径注入——进程内经 `registries.llm` store 惰性读取，隔离执行传 `agent.llms` 纯数据快照、worker 内动态加载 `@faapi/agent` 重建。

  @faapi/faapi 新增：`llm` 内置注入名、`AppRegistries.llm`（`LlmChannelStore`）、`LlmComplete`/`LlmCompleteOptions` 规范类型（主包持有，`TaskContext.llm` 引用）、`TaskQueueDeps.llm/llms`。

  provider 层（@faapi/agent）：新增 `LLMTimeoutError`（`LLMProviderError` 子类，可编程区分超时与网络错误）；`LLMCompleteRequest` 新增调用级 `timeoutMs`/`maxRetries` 覆盖；`LLMResponse.attempts` 携带实际 HTTP 尝试次数（重试耗尽抛出的错误对象同样回填）。均为可选新增字段/子类，向后兼容。

## 6.31.0

### Minor Changes

- dd194f2: agent-as-tool 派发入参支持 per-agent 富 schema 声明（结构性交接单）。

  子代理派发工具（`agent-<name>`）此前固定暴露单字段 `{ input: string }` 交接单，字段语义只能写进 `inputDescription` 描述文字。现在 agent handler.ts 顶层声明 `interface Input` / `type Input` 即启用富 schema 模式：构建期 AST 提取生成 `agents/<name>/zod.js`（导出 `InputSchema`，复用 tool/task 的 zod 产物管线，coerce=false），字段 JSDoc 即主控 LLM 可见参数描述；`executeSubAgent` 执行前校验，失败按工具同语义回灌 `{ error }` 给主控重试。未声明的 agent 保持单字段 `input` + `inputDescription` 行为，完全向后兼容。

  主包侧：`AgentMetadata` / 序列化清单新增 `inputTypeName` 字段（顶层 `Input` 导出检测）；`loadToolSchema` / `getToolSchemaPath` 参数放宽为最小结构 `{ filePath, inputTypeName? }`（新增导出 `SchemaSourceRef` 类型），同一加载器服务 tool 与 agent 两类 zod.js。agent 包侧：`AgentDeps` 新增可选 `resolveAgentInputSchema`（`createToolSchemaResolver` 返回值同时满足两个 resolver 签名，插件 setup 自动接线，任务内组装按需传入）；声明了 `inputTypeName` 但 zod.js 产物缺失时显式抛 `AgentError`（dev/prod 全量生成下只可能是产物异常，不静默退回单字段模式）。

## 6.30.0

### Minor Changes

- f3dc957: AgentDeps.ctx 类型放宽为 Partial<FaapiContext>——任务侧窄 ctx 免 cast 直传

  `@faapi/agent` 的 `AgentDeps.ctx` 与 `@faapi/faapi` 的 `AgentConfig` 三个鉴权钩子（`beforeToolCall` / `afterToolCall` / `filterTools`）的 ctx 参数类型从完整 `FaapiContext` 放宽为 `Partial<FaapiContext>`。此前类型要求完整上下文，但运行时框架对 ctx 零读取、纯透传给钩子与 tool handler 第二参数——任务内组装 Agent（无 HTTP 请求）的场景按类型无法构造窄身份对象（如 tool 鉴权硬闸需要的 `{ currentUserId }`），被迫 `as unknown as FaapiContext` 断言。放宽后窄对象免 cast 直传，`declare module` 增强字段随 Partial 保留类型提示；编程式直调不传时钩子照常收到 undefined，HTTP 请求路径传完整 ctx 不受影响。

  迁移说明：钩子实现若给 ctx 参数显式标注 `FaapiContext`，需删除标注（走推断）或改为 `Partial<FaapiContext>`——函数参数逆变下显式全量标注不再兼容钩子类型；未显式标注的实现无需任何改动。

## 6.29.0

## 6.28.0

### Minor Changes

- b073478: fix(agent,tools): 工具名全面满足 OpenAI 兼容协议字符集——派发名 `agent-` 前缀、嵌套分隔符 `_`、命名构建期校验

  发给 LLM 的工具名（`function.name`）受 OpenAI 兼容协议硬约束 `^[a-zA-Z0-9_-]+$`。此前两处违反：agent-as-tool 派发名硬编码 `agent.` 点号前缀；tool / agent 名的路径分隔与层级连接用 `.`（`weather.getWeather`、嵌套 agent 名 `easy-writing.wizard`）。DeepSeek / OpenAI 等强校验上游对整个 tools 数组直接 400（`Invalid 'tools[n].function.name': string does not match pattern`），带子代理派发或嵌套 tool 的对话整轮失败（业务方反馈 TODO-faapi-gaps #1）。

  **agent 侧**：

  - **派发工具名 `agent.xxx` → `agent-xxx`**：主包新增 `subAgentToolName(agentName)` 作为唯一生成入口（导出 `subAgentToolName` / `SUB_AGENT_TOOL_PREFIX` / `LLM_TOOL_NAME_PATTERN`），三处 `asTool`（`agentRegistry.asTool`、task worker 注册表视图、`Agent.asTool`）与 `Agent.buildToolDefinitions` 统一走它。
  - **agent 嵌套名分隔符 `.` → `_`**：目录推导名 `/` 规范化为 `_`（旧为 `.`），嵌套 agent `src/agents/easy-writing/wizard/` 的注册名变为 `easy-writing_wizard`，派发名 `agent-easy-writing_wizard` 整体合法；trace 的 `subagent_call.agentName` 剥前缀即精确还原。
  - **agent 名字符集构建期校验**：agent 目录段须匹配 `^[a-zA-Z0-9-]+$`（工具名字符集再禁 `_`——`_` 独占嵌套分隔符语义）；`@agent` JSDoc 覆盖名须整体匹配 `^[a-zA-Z0-9_-]+$`（无嵌套语义，`_` 可用）。违例扫描 / AST 阶段显式抛错。
  - **执行路由改声明来源判定**：`Agent.buildLoopConfig` 构建「派发名 → agent 名」映射与常规 tool 声明集合，`executeTool` 按声明集合路由，不再 `startsWith` 猜测——真工具 `agent-foo` 与 sub-agent `foo` 的派发名互不误伤（未声明的注册真工具也不会遮蔽派发名）。
  - **构建期冲突显式抛 `AgentError`**：sub-agent 派发名与该 agent 声明的常规 tool 名相同时启动 / run 即报错——静默遮蔽会让一方不可达。

  **tool 侧（同规则迁移）**：

  - **命名连接符 `.` → `_`**：tool 名 = 命名空间 + `_` + 函数名（旧为 `.`），嵌套命名空间段间也用 `_`（`src/tools/a/b/handler.ts` 导出 `deep` → `a_b_deep`，旧 `a.b.deep`）。
  - **字符集构建期校验**：tool 目录段须匹配 `^[a-zA-Z0-9-]+$`（同 agent 目录段规则）；合成 tool 名整体须匹配 `^[a-zA-Z0-9_-]+$`（函数名含 `$` 等非法字符时抛错）。`@tool` JSDoc 覆盖名须整体匹配 `^[a-zA-Z0-9_-]+$`，违例 AST 阶段抛错。违例均显式报错（含路径与改名 / `@tool` 覆盖指引），不静默净化。

  **迁移提示**（业务方需同步修改）：

  1. authHooks 中按 `agent.` 前缀判别 sub-agent 的逻辑改为 `agent-`（建议 import 主包 `SUB_AGENT_TOOL_PREFIX`，不硬编码）。
  2. 嵌套 agent 的引用名：`agents: ['a.b']` → `agents: ['a_b']`，`agent.run(input, { agent: 'a.b' })` → `'a_b'`。
  3. agent / tool 目录名含 `.` 或 `_` 的需改名（段内只允许字母数字连字符；旧版平铺点号目录 `easy-writing.wizard/` → `easy-writing-wizard/`），否则构建报错。
  4. 带命名空间的 tool 引用名：agent config `tools: ['weather.getWeather']` → `tools: ['weather_getWeather']`；authHooks 的 tool 名匹配同步改。
  5. LLM 对话历史里持久化的旧工具名（`agent.xxx` / `weather.getWeather`）不映射到新名——跨版本续跑的对话中旧名调用会被声明集合拒绝并回传 LLM。

## 6.27.0

## 6.26.0

## 6.25.0

### Minor Changes

- 1e401f8: 单进程单 app（多 app 同进程不支持）+ 运行时资源读取统一为免传参 `readResource`：

  - **单 app 强制**：`createAppBase` 检测到进程内已有存活 app 时显式抛错（提示先 `close()` 或用子进程隔离）——单例语义、全局日志、资源读取根绑定等进程级资源都以唯一 app 为前提。此前同进程多次创建为"覆盖单例"的未定义行为
  - **`readResource(relativePath, encoding?)`**：参数为相对路径，只能读取 resources 目录内的文件（绝对路径 / `..` 穿越 / 符号链接逃逸显式抛错，resources 内合法软链不误伤）；读取根在 app 启动时绑定、隔离任务 worker 由 wrapper 从快照播种、testing 直调经 `createTestContext` 的 `resourcesDir` 选项绑定，调用方（HTTP/WS handler、任务、插件、lifecycle）统一用这一个函数
  - **撤掉同批引入的 `ctx.readResource` sugar**（未随任何版本发布），保持单一读取形态
  - **agent `systemPromptFile` 读取切换到免传参 `readResource`**，获得越界/符号链接逃逸防护；`AgentDeps.resourcesDir` 字段随之移除（唯一读者消失成死字段）——app 内与隔离 worker 场景读取根自动就位，无需手工注入

  > 留痕说明：多 app 能力此前记录于注册表实例化章节，去掉属行为收敛，按语义为 breaking（major）；经维护者确认业务侧无同进程多 app 使用，按 minor 发版（同 agent 自定义 run 移除先例）。

## 6.24.0

### Minor Changes

- ac31b43: 移除 agent 自定义 `run` 机制——agent 统一为声明式执行（config + 默认 reactLoop）。

  - agent handler.ts 检测到 `export function/const run` 时构建期抛 `SchemaExtractionError`（含迁移指引）：编排场景**注册 tool**（有 schema 校验、trace 采集、鉴权钩子覆盖），多 agent 协作用 config.agents 声明 sub-agent（继承 provider、delta 冒泡、usage 整树上卷）
  - 删除导出：`loadAgentModule` 函数与 `AgentModule` 类型、`AgentMetadata.hasRun` / `AgentManifest.hasRun` 字段、`AgentDeps.loadAgentModule`
  - `AgentMetadata.filePath` 保留（声明文件定位与清单可观测性）；`getAgentEntry` 保留
  - `systemPrompt` / `systemPromptFile` 二选一必填对全部文件型 agent 生效（config 豁免随 run 一并移除）

  > 说明：本变更删除了 `loadAgentModule` / `AgentModule` / `hasRun` 等公开 API，严格语义为 breaking——经维护者确认当前业务项目均未使用自定义 run（agent 统一为声明式，编排场景由 tool 承接），故按 minor 发版。

## 6.23.0

## 6.22.0

## 6.21.1

### Patch Changes

- 307dc41: 修复 OpenAI provider `stream()` 对截断流的静默 finalize：无 `[DONE]` 且无 `finish_reason` 的流结束现在抛 `LLMProviderError`

  此前流自然结束（`done=true`）时无条件 `finalizeStreamChunk`——上游/网关中途掐断连接时，部分累积的 tool_calls / 内容会冒充完整响应返回，截断轮次静默污染 agent 历史（主控拿到残缺的子代理回报后照常推进）。

  现改为两道防御：

  - 流自然结束但既无 `[DONE]` 也无 `finish_reason` → 抛 `LLMProviderError`（truncated upstream stream）。仅缺 `[DONE]` 但有 `finish_reason` 视为省略哨兵的完整流（部分 OpenAI 兼容上游不发 `[DONE]`），保持兼容
  - chunk 携带非空 `error` 字段（OpenAI 生态惯例线格式 `data: {"error":{...}}`，网关/上游中断时下发）→ 原样抛出并携带上游错误文本，不再被静默忽略

  配合网关侧「流中途异常先发错误事件再关流」的信号（如 llm 中转网关），截断轮次从静默污染变为带可读原因的显式失败，由调用方决定重试。

## 6.21.0

## 6.20.0

## 6.19.0

## 6.18.1

## 6.18.0

### Minor Changes

- 5f7a69a: `AgentRuntimeConfig.maxHistoryTokens` 全链路接线生效——此前 plugin 已把 `config.agent.maxHistoryTokens` 拷入 runtimeConfig，但 `buildLoopConfig` 构造循环配置时从不读取该字段，全局配置静默失效（`reactLoop` 的历史裁剪永不触发，长循环对话历史无上限增长——恰是该配置要防的问题）。现在配置正确透传 `ReactLoopConfig.maxHistoryTokens`，超预算时按轮组裁掉最旧历史（system 与初始 user 保留），补接线回归测试。
- 4aea6d1: agent tool 执行超时 + LLM 坏 JSON 参数自愈路径修复：

  - 新增 `AgentRuntimeConfig.toolTimeoutMs`：单次 tool 执行超时毫秒数（未设置 = 不限时，行为不变）。超时抛新增的 `AgentToolTimeoutError`（公开导出），被 reactLoop 按既有 tool 错误路径回传 LLM——挂死的 tool handler（如无超时的内部 fetch）此前会让整个 run 永久挂起，且 run 的 abort signal 对 tool 执行无效
  - **OpenAI provider 不再对 tool_calls.arguments 做 fail-fast JSON 预校验**（非流式 `normalizeToolCalls` 与流式 `finalizeStreamChunk` 两处）：maxTokens 截断产生的半截 JSON 此前会在 provider 边界抛 `LLMProviderError` 让整个 run 死亡，reactLoop 宣称的"解析失败回传 LLM 自愈"路径不可达；现在半截 JSON 原样透传，由 reactLoop 的 per-tool 错误路径把解析失败回传 LLM（LLM 可修正参数重试）。若业务方依赖捕获 `LLMProviderError` 处理坏参数，请改为在 tool 结果消费侧处理
  - `afterToolCall` 审计钩子自身抛错改为只 `console.error` 留痕——此前钩子在结果返回前同步调用且无隔离，审计系统故障会把成功的 tool 结果变成错误回传 LLM（执行语义被审计钩子劫持，LLM 拿到审计报错还可能重试）

- 5d174af: 新增子代理 delta 冒泡（GAP-1）：流式父循环执行 sub-agent（`agent.<name>` tool call）时，嵌套循环的思考与产出增量实时冒泡到父流——多 agent 协作页面此前只能显示动作短语行，子代理长任务期间用户得不到过程反馈，排障只能事后开 tracing。

  - `ReactLoopStreamChunk` 新增 `subagentDelta` chunk：`{ name: 'agent.<名>', depth, deltaContent?, deltaReasoning? }`（`depth` 与 `maxAgentDepth` 口径一致，根循环 = 1）；类型 `SubAgentDelta` / `SubAgentDeltaEmitter` 公开导出。冒泡顺序即实际输出顺序
  - 机制：`await executeTool` 期间 async generator 挂起无法 yield——流式路径对每个 tool call 采用 fire-and-drain 泵（fire 执行 → generator 侧 drain 队列逐个 yield → 完成后 flush 剩余）；执行抛错时已 emit 的增量仍透出，错误走既有 tool 错误路径
  - 父为流式时 `executeSubAgent` 让子循环也跑流式（此前固定非流式 `run()`，子循环没有流式增量可冒泡）；从子流 `done` / `traceEvent` 拼装结果，usage/turns 上卷与 `subagent_call` 嵌套 trace 结构不变
  - 语义不变式：嵌套 `reasoning_content` 依旧不进 messages 历史与续跑源（仅透出）；非流式 `run()` 不受影响（结果一次性返回）；自定义 `run` 的 sub-agent 无结构化增量、不冒泡（与 usage 计 0 同口径）；中断 / `maxAgentDepth` / 历史剥离全部不回归

## 6.17.0

### Minor Changes

- e8d8f3f: `ReactLoopResult.usage` / `turns`（流式 `done.usage` / `done.turns`）升级为整树口径——`usage` 为本次 run 全部 `llm_call` usage 之和（含全部层级 sub-agent 循环，多层递归逐层上卷），`turns` 同口径聚合（主循环轮数 + 全部 sub-agent 循环轮数）。原「只含主循环」口径会系统性低估多 agent 场景的用量（GAP-1），属缺陷修正。`maxTurns` 循环控制与 trace 事件 `turn` 序号不受影响，仍为主循环口径；自定义 `run` 的 sub-agent 无结构化用量、计 0；tracing 关闭时上卷照常生效（用量台账不依赖 tracing）。机制：`Agent.executeSubAgent` 把子循环结果统一包装为新增的 `SubAgentToolResult`（`{ __subAgent, result, usage?, turns?, trace? }`），reactLoop 识别后上卷再剥壳回传 LLM；旧 `TracingToolResult` 仍兼容识别（仅发 `subagent_call` 事件、不上卷用量），已标 `@deprecated`。

## 6.16.0

## 6.15.0

## 6.14.0

### Minor Changes

- e9874c8: feat(agent): agent-as-tool 派发工具改用显式单字段 input 入参 schema

  sub-agent 工具（`agent.<name>`）暴露给 LLM 的 `function.parameters` 从无属性 `{ type: 'object' }` 改为显式入参约定：`{ type: 'object', properties: { input: { type: 'string', description } }, required: ['input'] }`。严格遵循 JSON schema 的模型（GLM 系列、OpenAI strict mode 等）对无属性 object 只会回空 `{}`，导致主控 agent 派发子代理时交接单（任务上下文）无法传递；宽松填参的模型不受影响。

  配套变更：

  - `AgentCore` 新增可选字段 `inputDescription`（文件型 agent 在 config 块声明，DB skill 直接填字段），作为该工具 `input` 字段的 schema description；未声明时用框架默认文案。声明了非字符串值在构建期抛 `SchemaExtractionError`。
  - `executeSubAgent` 默认 reactLoop 路径：tool call args 恰为单字段 `{ input: <string> }` 时直传字符串作为子代理 user 消息（去 JSON 壳）；其余形状（宽松模型多传字段/传空对象/任意 JSON）保持 `JSON.stringify` 兜底，向后兼容。
  - 自定义 `run` 函数始终接收原始 args 对象（默认 schema 下形状为 `{ input: '交接单' }`），建议业务方读 `args.input` 取交接单。

## 6.13.0

## 6.12.0

## 6.11.0

## 6.10.1

## 6.10.0

## 6.9.1

## 6.9.0

## 6.8.0

## 6.7.0

## 6.6.0

### Minor Changes

- a019806: 新增公开导出 `createToolSchemaResolver({ rootDir? })`——任务内组装 Agent 时 `AgentDeps.resolveToolSchema` 的官方工厂。

  此前该装配逻辑（`loadToolSchema` + `z.toJSONSchema` + `safeParse`）是 `@faapi/agent` 插件内部实现，任务侧手动组装 Agent 只能拿到返回 `{ schema, schemaName }` 原始 zod 模块的 `loadToolSchema`，直连后运行时报 `schemaRes.validate is not a function`。现将插件内部实现抽为公开工厂（带 mtime 缓存，与插件行为一致），`rootDir` 缺省 `process.cwd()`（任务侧 `TaskContext` 无 rootDir）；插件 setup 同步改为复用该工厂。另在任务侧文档（taskTypes.md「任务内组装 Agent」章节）补充完整 deps 组装示例。

## 6.5.0

## 6.4.1

## 6.4.0

## 6.3.0

## 6.2.0

## 6.1.0

### Minor Changes

- 92b4467: agent 子系统支持 thinking（推理内容）：OpenAI provider 解析 thinking 模型的推理输出（`reasoning_content` 线格式优先，兼容 OpenRouter 的 `reasoning`），非流式经 `LLMMessage.reasoning_content` 与 `ReactLoopResult.reasoning` 透出，流式经 `LLMStreamChunk.deltaReasoning` / `done.reasoning` 逐段透传；推理内容不回传 LLM API（请求侧剥离）也不进入对话历史（续跑 / 持久化历史保持 OpenAI 线格式纯净），仅 trace 的 `llm_call.response` 保留完整原始返回供观测。

## 6.0.0

### Patch Changes

- Updated dependencies [c5a6775]
  - @faapi/faapi@6.0.0

## 5.4.0

## 5.3.0

## 5.2.0

## 5.1.0

## 5.0.1

### Patch Changes

- 版本线修复：此前 5.0.0 被误发布到 npm（其中 `@faapi/faapi` 与 `@faapi/mcp` 因依赖关系无法 unpublish，该版本号已作废不可复用），版本线跳过 5.0.0 对齐到 5.0.1。本版本功能内容与 4.5.0 完全一致（含移除 `config.agent` 的 `defaultAgent` / `defaultLlm` 配置——`agent.run/stream` 改为每次调用显式传 `options.agent` 与 `options.model` / `options.provider`）。

## 4.5.0

### Minor Changes

- 74568a7: 移除 `config.agent.defaultAgent` 与 `config.agent.defaultLlm`——agent 调用全面显式化，无全局默认 agent / 默认 provider：

  - `agent.run` / `agent.stream` 每次调用必须显式传 `options.agent` 指定 agent 名，不传抛 `AgentError`
  - LLM 定位无默认 provider：每次调用传 `options.model`（llms key / `provider/model` / 纯 model 名）或 `options.provider`（外部 provider）；未传 `options.model` 时 agent 元数据声明的 `config.model` 作为缺省 key 参与 llms 解析，两者皆无且未传外部 provider 时抛 `AgentError`
  - sub-agent 递归继承父调用解析出的 provider，model 用 sub 元数据声明的 `config.model`、未声明时沿用父 model
  - `asTool` 改为显式传 agent 名：`asTool(name)`
  - 原依赖 `defaultAgent` / `defaultLlm` 的配置需迁移：handler 内改为 `agent.run(input, { agent: 'name', model: 'xxx' })`

## 4.4.0

### Minor Changes

- 9cf38e1: `agent.run` / `agent.stream` 新增 `options.provider`——调用时传入外部 provider（`LlmConfig` 配置对象或 `LLMProvider` 实例），本次调用完全不查 `config.agent.llms`。适用于 BYOK（用户自带 apiKey）、按请求指定 baseURL 网关、注入自定义 `LLMProvider` 实现（内部自研模型网关）等场景。传入时 `options.model` 变为原始 model 名原样透传（不做 llms key 解析，支持带 `/` 的 model id）；仅本次调用生效，sub-agent 递归不继承。

  `config.agent.llms` 变为真正可选：未配置 llms 时 `@faapi/agent` 插件仍注册 agent handle 工厂，`agent` 参数正常注入，但 `agent.run/stream` 不传 `options.provider` 时抛 `AgentError`（原先 llms 缺失直接跳过注册，`agent` 参数为 `undefined`）。`config.agent.defaultLlm` 指向不存在的 key 时从「跳过注册」放宽为「warn + 照常注册（无默认 provider）」。服务端不托管 LLM 凭证、凭证完全由请求侧提供的项目，现在可以只声明 `plugins: ['@faapi/agent']` 而不配置 `agent.llms`。

## 4.3.0

### Minor Changes

- 8e959cc: agent 子系统支持中断恢复（Resume）：`AgentAbortError` / `ReactLoopError` 新增 `messages` 属性携带断点/完整历史；`agent.run` / `agent.stream` 的 `input` 变为可选，新增 `options.messages` 从断点续跑（历史缺 system 时自动补齐 agent systemPrompt，非空 input 追加为多轮对话）。`AgentAbortError`/`ReactLoopError` 构造函数新增可选 `messages` 参数，向后兼容。

## 4.2.1

## 4.2.0

## 4.1.0

### Patch Changes

- dcf100e: @faapi/agent 启动时对空 apiKey 的 provider 打 warn

  plugin setup 时校验 `config.agent.llms.<key>.apiKey`：空/缺失/纯空白字符时打印 warn（含 provider 名与修复提示），把「key 未配置」从首次 LLM 调用的上游 401 提前到启动日志。照常注册不跳过——部分网关/本地模型场景无需 key，跳过会破坏合法配置。

## 4.0.0

### Major Changes

- a0cb30c: # 注册表实例化（方案 A）：tool/agent/skill/agentHandle 注册表从进程级全局单例改为 app 实例级状态

  ## 变更

  每个 app（`createAppBase`）现在创建并持有独立的注册表集合（`AppRegistries`），水合、请求链路、插件、lifecycle 钩子均读写 app 自己的实例，`app.close()` 随实例销毁。多 app 同进程互不串台——此前模块级全局单例 + hydrate 整体替换语义下，后创建的 app 会覆盖先创建的 app 的清单，跨项目数据串台且无报错。

  ## 破坏性变更
  - **app 不再填充全局单例**：启动后 `getTool()` / `listAgents()` 等全局函数返回默认实例（空）——请改用 `app.registries`（`AppBase` 新增字段）或 `ctx.registries`
  - **`app.close()` 只清自己的实例**：不再调用全局 `clearToolRegistry()` 等
  - **业务方 skill 灌入路径变更**：`lifecycle.onReady(ctx)` 的 `ctx` 新增 `registries` 字段，请改用 `ctx.registries.skill.hydrate/upsert`——经全局 `hydrateSkillRegistry` 灌入的数据不会进入 app 的请求链路
  - **`PluginContext` 新增必填 `registries`**：自定义插件若实现了 PluginContext 形状的 mock/适配需补此字段
  - **`@faapi/agent` 插件**：工厂注册与 deps 改走 `ctx.registries`（app 实例）——模拟插件 setup 的测试需改用真实 `createAppRegistries()`

  ## 新增 API
  - `createAppRegistries()`：创建一套 app 级注册表
  - `AppRegistries` / `ToolRegistry` / `AgentRegistry` / `SkillRegistry` / `AgentHandleStore` 类型
  - `AppBase.registries` / `AppContext.registries` / `FaapiContext.registries?` / `LifecycleContext.registries` / `PluginContext.registries`
  - `@faapi/faapi/testing` 的 `CreateTestContextOptions.registries?`

  ## 兼容保留

  四个注册表模块的全局函数（`getTool` / `hydrateToolRegistry` / `getAgent` / `listAgents` / `hydrateSkillRegistry` / `upsertSkill` / `registerAgentHandleFactory` 等）保留，作为**默认实例**的便捷访问器（编程式直调 / 单元测试场景）。注意默认实例与 app 实例相互独立。

### Minor Changes

- 0337482: agent / tools 调用链新增鉴权钩子与请求上下文传递（authHooks）：

  - **ctx 全链路传递**：`@faapi/agent` 工厂捕获请求上下文（此前工厂签名接收 ctx 但未使用），tool handler 签名扩为 `(args, ctx)`、sub-agent 自定义 `run(args, ctx)`——中间件塞入的身份信息（`ctx.user` / `ctx.workspace` 等）首次可流达 tool 层；sub-agent 递归经 deps 展开自动传导
  - **`beforeToolCall` 执行守卫**（`config.agent`）：所有 tool + sub-agent 调用的必经单点（拦截在 `agent.` 分流之前，一个钩子覆盖两者）。三种返回：`void` 放行 / `{ error }` 拒绝（不执行，error 回传 LLM 调整策略）/ `{ args }` 改写后放行——多租户场景强制注入可信 `workspaceId`，不信任 LLM 传入的标识参数
  - **`afterToolCall` 审计钩子**：tool / sub-agent 成功返回后调用（异常路径不调用），用于日志/审计/计量
  - **`filterTools` 可见性过滤**：每次 `run` / `stream` 组装 LLM 可见 tools 清单后过滤（含 agent-as-tool 项）——无权 tool 不进 LLM 视野，比执行时拒绝省一轮调用
  - **不引入洋葱中间件**：拒绝语义是 `{ error }` 回传 LLM 而非 403 短路，钩子对覆盖中间件全部实际用途；入口鉴权沿用现有 HTTP 中间件，零新增
  - 设计文档见 `@faapi/agent` 的 `authHooks.md`；使用场景见 faapi-dev 技能 agent.md 的「agent / tools 鉴权（工作区）」章节

- 8947f46: agent 循环可靠性两项改进：

  - **历史 token 预算（`maxHistoryTokens`）**：多轮 tool 循环中对话历史只增不减，大 tool 结果会把发给 LLM 的消息撑爆上下文窗口导致下一轮 400、整个 run 失败。现在可配置 token 预算（近似估算），超预算时从最旧的「轮组」（assistant + 其后全部 tool 结果）开始裁剪——system 与初始 user 永不裁剪、tool 配对不拆散、至少保留最近一轮；裁剪只作用于发给 LLM 的消息副本，本地历史与 trace 不受影响。非流式与流式一致。被裁掉的旧轮不生成摘要（compaction 属后续能力）
  - **同轮多 tool_call 并行执行**（非流式路径）：LLM 一轮返回多个 tool_call 时从串行改为 `Promise.all` 并行，总耗时从各 tool 之和降为最慢一个。结果仍按 toolCalls 声明顺序回传（与完成顺序无关）、单个 tool 失败不影响其余；`beforeToolCall`/`afterToolCall` 钩子会并发触发（业务方钩子不应依赖调用顺序）；流式路径保持串行（yield 顺序受消费端约束）
  - `config.agent.maxHistoryTokens`（faapi 配置面）同步新增，plugin 转发至 reactLoop

- eadf440: agent 子系统 LLM 调用层新增超时、重试与取消支持（生产长任务稳定性）：

  - **取消（AbortSignal）**：`agent.run/stream` 的 options 新增 `signal`，沿 agentHandle → Agent → reactLoop → provider 透传到底层 HTTP 请求。循环每轮开始前预检查，执行中取消请求中断并抛 `AgentAbortError`（新导出）——业务方通过 `instanceof` 区分用户取消与真实错误（SSE/WS 客户端断开后不再白烧 token）
  - **超时**：`LlmConfig.timeoutMs`（毫秒，可选，未设置时无超时），provider 层用 `AbortSignal.timeout` 实现，与 run-level `signal` 组合生效；超时触发抛 `LLMProviderError`（message 含 timed out）
  - **重试**：429 / 5xx / 网络错误自动重试，`LlmConfig.maxRetries`（默认 2，设 0 关闭）。退避优先尊重响应 `Retry-After` 头（封顶 30s），否则指数退避 500ms × 2^attempt；4xx 其他状态（400/401 等）确定性错误不重试；流式仅在连接建立前重试，每次重试刷新超时预算
  - **流取消**：stream 提前终止（消费者 break）时主动 `reader.cancel()` 释放底层 HTTP 连接，不再等待 body 缓冲耗尽

### Patch Changes

- f60d137: 框架评估修复批次 1：三个 P0 功能缺陷 + 热路径性能 + 安全边界。

  **@faapi/faapi**

  - **dev 按需编译补齐依赖闭包（P0）**：`ensureCompiled` 此前只编译 handler 单文件，handler 引用的共享模块（`../../lib/db`）无产物，首次请求 import 即 `ERR_MODULE_NOT_FOUND`——真实项目 dev 模式不可用。现在通过 `collectRelativeImports`（相对 import + tsconfig paths 别名，见 `collectImports.md`）收集 src 内传递依赖后批量编译；`middlewares.ts` 同样在首次加载前按需编译（`ensureMiddlewaresCompiled`）。新增依赖闭包完整请求链路 e2e
  - **zod.js 命名类型文件级去重（P0）**：同一 handler 文件的多个方法引用同一命名类型时，产物含重复 `const` 声明，zod.js import 即 SyntaxError、该文件所有路由 500。现在命名类型声明按名去重后提升到文件头只生成一次（`generateZodSchemaSourceParts` 结构化片段，消灭 import 剥离正则的字符串协议）
  - **跨文件类型二次引用不再静默降级 `z.unknown()`（P0）**：`import type { User }` 类型二次引用经惰性解析器找不到声明时静默生成 `z.unknown()`，校验弱于 TS 类型且无告警。现在 `extractTypeInfo` 回退到 program 其他源文件查找同名顶层声明（与 `resolveImportAlias` 兜底语义一致），仍找不到时按"不降级放行"约定显式抛 `SchemaExtractionError`
  - **每请求热路径去掉 TS AST 解析**：`resolveInjection` 此前每请求对 handler 做 `fn.toString()` + 完整 TS 解析（无缓存），现在按函数引用 WeakMap 缓存，handler 只解析一次
  - **`listen()` 处理 `error` 事件**：端口被占用（`EADDRINUSE`）此前以裸堆栈崩进程且 Promise 永不 settle，现在 reject 携带端口号与排查提示的友好错误
  - **SSE 断连内存泄漏**：客户端断开时源流不销毁导致 `SseWriter.aborted` 永不置位、数据堆积在无消费者的流 buffer。现在断连时销毁源流（触发 web stream cancel）并按正常完成收尾；`handleRequest` catch 对已断开连接跳过 500 兜底与 onError 误报
  - **WS 修复**：upgrade 监听器整体兜底 catch（此前路由匹配/上下文构造抛错即 unhandled rejection 崩进程）；二进制帧透传 Buffer（此前强制 utf8 解码不可逆损坏二进制协议）；upgrade 监听无条件挂载（修复 dev watch 中新增第一个 WS 路由永远 404）
  - **DELETE body 语义对齐**：此前 DELETE 校验后的 query 被当作 body 注入（handler 声明 `body` 静默拿到 query），且请求体流不消费导致 keep-alive 连接无法复用。现在 DELETE body 单独解析注入（无 schema 不校验）
  - **状态码映射对齐 zod v4**：缺失必填字段此前返回 422 `TYPE_MISMATCH`（文档承诺 400 `MISSING_FIELD`），现在正确映射；补 `invalid_format`/`invalid_key`/`invalid_element` 映射，删除 zod v3 遗留死代码
  - **main.js 路径转义**：`--dist` 传入 Windows 反斜杠路径时生成损坏代码（`.\build` 的 `\b` 变退格转义），改用 `JSON.stringify` 生成合法字符串字面量
  - **watcher 修复**：config 文件事件不再喂给 `compileDevRoutes`（此前在 `.faapi/_.._/` 下堆积垃圾产物）；`ignored` 过滤改按路径段判断（不误伤 `node_modules-helper.ts` 类合法文件名）

  **@faapi/mcp**

  - **`tools/call` 参数净化**：校验后此前 `Object.assign(args, parsed.data)` 把 schema 未声明的任意字段原样透传给 handler（strip 语义失效，原型污染类注入面），现在直接传 `parsed.data`
  - **协议对齐**：参数校验失败改为返回 `isError: true` 的 tool result（LLM 可自纠）而非协议层 -32602；非 initialize 请求要求完成握手（`notifications/initialized`）+ 携带有效 `Mcp-Session-Id`（防跳过能力协商/匿名调 tool）
  - **Origin 校验**：新增 `allowedOrigins` 选项（`createMcpHandler`/`createMcpNodeHandler` 透传），MCP 规范建议的 DNS rebinding 防护
  - 移除未使用的必需 peerDependency `@faapi/faapi`（独立 MCP SDK 不应强制拖入整个框架）

  **@faapi/agent**

  - **`tools`/`agents` 声明成为执行白名单**：此前声明只约束 LLM 可见性，LLM 幻觉或被提示注入时可执行任意已注册 tool/sub-agent。现在执行前按声明集合强制校验，未声明拒绝并回传 LLM（每个 depth 层按自己的声明集合校验）

- c18c62e: 框架评估修复批次 4：注册表清理所有权、MCP 定时器泄漏、观测数据修正与会话上限。

  **@faapi/faapi**

  - **注册表清理所有权守卫**：`app.close()` 此前无条件清空全局 tool/agent/skill 注册表与 agent handle 工厂——同进程多 app 场景（测试/嵌入）下，先创建的 app close 会清掉运行中 app 的注册表。现在仅在自身是当前单例 app 时清理，与单例清理的所有权检查语义对称

  **@faapi/mcp**

  - **Node 适配器 SSE 断连泄漏修复**：客户端断开后源流不销毁，底层 web ReadableStream 的 `cancel()` 永不触发——SSE 心跳 `setInterval` 持续 enqueue 到无消费者的流（定时器 + 队列持续泄漏）。现在断连时销毁源流并按正常完成收尾（与主包 sendNodeResponse 语义一致）
  - **SessionManager 会话数上限**：新增 `sessionMaxSessions` 选项（默认 1000，0 不限），`create` 时超限按 LRU（最久未活动）淘汰并关闭订阅者——防 initialize 洪水在 TTL 窗口内无限堆内存

  **@faapi/agent**

  - **并行 tool tracing durationMs 失真修复**：结束时间此前在 `Promise.all` 之后的串行循环里统一采集，同轮每个 tool 的 `durationMs` 都包含等待其他 tool 的时间（全部失真为「最慢 tool」耗时）。现在在各自执行闭包内采集，`durationMs` 只反映自身执行耗时

- 3c12dc6: 修复三处正确性问题：

  - **@faapi/faapi**：`interface extends` 继承不再抛 SchemaExtractionError（heritage 节点此前未接入解析链，与文档承诺不符）；同时新增泛型类型支持——泛型 interface / type 别名按位置绑定类型实参（`Box<string>`）、支持默认类型形参（`<T = string>`）、泛型形参遮蔽同名真实类型，实参缺失且无默认时显式抛错
  - **@faapi/mcp**：GET SSE 心跳 tick 续期 session（`SessionManager.touch`），只收推送不发请求的客户端不再因空闲 TTL 被 30 分钟强制断开；携带无效/已过期 `Mcp-Session-Id` 的 GET 请求改为返回 404（MCP 规范），客户端可据此重新 initialize 而非静默空转
  - **@faapi/agent**：OpenAI provider 的 SSE 解析兼容 CRLF / CR 行尾（SSE 规范允许），使用 CRLF 行尾的 OpenAI 兼容网关此前流式输出完全失效（事件无法切分、`[DONE]` 识别失败）

- Updated dependencies [0337482]
- Updated dependencies [8947f46]
- Updated dependencies [eadf440]
- Updated dependencies
- Updated dependencies [981c99f]
- Updated dependencies [f60d137]
- Updated dependencies [f60d137]
- Updated dependencies [d822718]
- Updated dependencies [c18c62e]
- Updated dependencies [13c6297]
- Updated dependencies [6f2903f]
- Updated dependencies [b31a442]
- Updated dependencies [3c12dc6]
- Updated dependencies [4617c07]
- Updated dependencies [9d5865d]
- Updated dependencies [a0cb30c]
  - @faapi/faapi@4.0.0

## 3.3.0

### Minor Changes

- 515e498: `config.agent.defaultAgent` 改为可选：未设置时插件正常注册工厂，handler 通过 `agent.run(input, { agent: 'name' })` / `agent.stream(input, { agent: 'name' })` 按调用指定 agent。两者均未指定时 `run`/`stream` 抛 `AgentError`。此前未设置 `defaultAgent` 会跳过工厂注册（`agent` 参数注入 `undefined`）。
- 21957b1: tracing 默认值从开启改为关闭（opt-in）——`enableTracing` 不再默认 `true`，不开启时 `agent.run()` / `agent.stream()` 返回的 `result.trace` / `chunk.traceEvent` 为 `undefined`，零开销运行。

  tracing 采集每轮 LLM 消息快照与 tool 明细，有真实内存/CPU 开销，此前所有不知情的用户都在隐性支付这笔成本。需要观测的端点显式开启：`config.agent.enableTracing: true`（全局）或 `agent.run(input, { enableTracing: true })`（单次调用）。

### Patch Changes

- d9a2830: `@faapi/agent` 性能优化：tool schema 解析新增跨请求缓存。此前 Agent 工厂每请求构造新实例，每个请求都重新执行 `loadToolSchema`（dynamic import）+ `z.toJSONSchema`（CPU 密集）；现在 setup 闭包级缓存解析结果，按 zod.js 路径 + inputTypeName 作键、文件 mtime 自校验失效（dev `reloadTools` 重生成后自愈，prod 永远命中），并发请求共享同一次解析。高 QPS agent 端点每请求省去 schema 重复解析开销。

  `@faapi/faapi` 新增 `getToolSchemaPath(tool, rootDir?)` 公开导出（计算 tool 的 zod.js 绝对路径，纯路径计算），与 `loadToolSchema` 共享 dist 解析逻辑。

## 3.2.1

## 3.2.0

### Minor Changes

- 新增 tracing：单次 agent 调用的结构化 trace（含 LLM 调用、tool 调用、sub-agent 嵌套调用事件 + timing + token 用量）

  ## 变更说明

  `agent.run()` / `agent.stream()` 默认开启 tracing（`enableTracing` 默认 true）。开启时返回值附加结构化调用明细：

  - **非流式**：`ReactLoopResult.trace?: AgentTrace`（agentName + startedAt + durationMs + turns + usage + stopReason + content + events）
  - **流式**：`ReactLoopStreamChunk.traceEvent?: AgentTraceEvent`（与 deltaContent / toolCall / toolResult / done 互斥,增量推送）

  事件类型（discriminated union）：`llm_call`（每轮 LLM 调用）/ `tool_call`（常规 tool）/ `subagent_call`（sub-agent 调用,内嵌递归 trace）。

  ## 新增 API

  `@faapi/agent` 导出：

  - 类型：`AgentTrace` / `AgentTraceEvent` / `LlmCallEvent` / `ToolCallEvent` / `SubAgentCallEvent` / `TracingToolResult`
  - 类型守卫：`isTracingToolResult(value)`
  - `ReactLoopConfig.enableTracing?: boolean`（默认 true）
  - `ReactLoopResult.trace?: AgentTrace`
  - `ReactLoopStreamChunk.traceEvent?: AgentTraceEvent`
  - `AgentRunOptions.enableTracing?: boolean`
  - `AgentRuntimeConfig.enableTracing?: boolean`

  `@faapi/faapi` 导出：

  - `AgentConfig.enableTracing?: boolean`（全局默认,默认 true）

  ## 三层覆盖优先级

  `AgentRunOptions.enableTracing` > agent 自身配置 > `config.agent.enableTracing`（默认 true）。

  ## sub-agent 嵌套 trace

  `Agent.executeSubAgent` 在 `enableTracing=true` 时把 sub-agent 返回的 `result.trace` 包装为 `TracingToolResult`（`{ __trace: true, result, trace }`）返回给 reactLoop,reactLoop 通过 `isTracingToolResult` 识别后发出 `subagent_call` 事件,嵌入 sub-trace（递归结构,业务方可还原完整调用树）。

  `enableTracing=false` 时 `executeSubAgent` 返回 `result.content`（与常规 tool 一致,零开销）。

  ## 性能开销

  | 场景                                  | 开销                                                                                                                 |
  | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
  | `enableTracing=false`（opt-out 关闭） | 零——无新对象构造,无 timing 调用,与现状完全一致                                                                       |
  | `enableTracing=true`（默认）          | 每轮 1 次 `performance.now()` 配对（< 1μs）+ 每事件 ~100B 对象 + sub-agent 递归采集。100 轮估算 < 10KB trace + < 1ms |

  ## 业务方影响
  - **默认开启**：业务方在生产高 QPS 端点显式 `agent.run(input, { enableTracing: false })` 或 `config.agent.enableTracing: false` 关闭以零开销运行
  - **调试 / 开发面板 / tracing 端点**：用 `result.trace` 或流式 `chunk.traceEvent` 持久化到 DB / Jaeger / OpenTelemetry
  - **sub-agent handler 导出 `run` 函数时无 trace**：业务方自己返回业务结果,不参与 reactLoop 的 tracing 采集——需 trace 时让 sub-agent 走默认 reactLoop（不导出 `run`）

  ## 未变更
  - `reactLoop` / `reactLoopStream` 的循环逻辑、消息格式、tool 执行流程保持不变
  - `AgentHandle` 接口签名不变（`run` / `stream` / `asTool`）
  - `AgentConfig` 现有字段（`llms` / `defaultLlm` / `defaultAgent` / `maxTurns` / `maxAgentDepth`）保持不变

- skill 与 agent 物理隔离：移除 agentRegistry 对 skillRegistry 的 fallback

  ## 变更说明

  skill 与 agent 职责正交不耦合,重新明确分工：

  - **agent 负责核心流程**：含 `run` 函数的多步 prompt 串联、文件型入口、sub-agent 递归
  - **skill 用于拓展**：运行时动态补充的 LLM 可见元数据,业务方 plugin 自行编排使用

  ## 破坏性变更

  `agentRegistry` 的查询函数（`getAgent` / `listAgents` / `asTool` / `resolveAgentTools` / `resolveSubAgents`）**不再 fallback 到 `skillRegistry`**：

  - `getAgent(name)` 仅查文件 registry,不再先查 skillRegistry
  - `listAgents()` 只返回文件型 agent,不再合并 skillRegistry（同名时 skill 不再覆盖文件型 agent）
  - `resolveSubAgents(name)` 不再 fallback 命中 skill——父 agent 的 `agents` 列表只能引用文件型 agent,skill 不参与 sub-agent 递归
  - `asTool(name)` / `resolveAgentTools(name)` 同样不 fallback 到 skillRegistry

  ## 业务方影响
  - `agents` 参数注入（`agentRegistry.listAgents()`）现在只返回文件型 agent,不再包含 DB-driven skill
  - DB skill 不再被 `@faapi/agent` 子包的 Agent 类自动消费、不再被 agent 的 `agents` 列表自动引用
  - 业务方需要让 handler 看到 skill 时,自行通过注入器或中间件机制注入（如 `getSkill(name)` 查询后塞到 ctx,通过 `injectors` 按参数名匹配注入）

  ## 未变更
  - `skillRegistry` API（`hydrateSkillRegistry` / `upsertSkill` / `removeSkill` / `getSkill` / `listSkills` / `clearSkillRegistry`）保持不变
  - `@faapi/agent` 子包的 `Agent` 类、`AgentHandleFactory` 逻辑不变（只消费 `agentRegistry`）
  - `injectParams.ts` 的 `agent` / `agents` 注入器逻辑不变（只调 `agentRegistry`）
  - `createAppBase` 的水合流程不变（只在 close 时调 `clearSkillRegistry`）

  ## 升级指南

  依赖 `getAgent` fallback 命中 DB skill 的业务方需要改写：原本直接 `getAgent('translator')` 能命中 DB skill 的代码,现在返回 `undefined`。改用 `getSkill('translator')` 直接查询 `skillRegistry`,并通过自定义注入器或中间件把 skill 注入到 handler。

## 3.1.0

### Minor Changes

- 重构 LLM 配置为嵌套级联结构（provider 在外层，model 在 `models` 下挂多个），并把 `AgentHandle.run` / `stream` 的 `options.model` 改为字符串 key 解析。

  ## 破坏性变更

  ### `@faapi/faapi` — `LlmConfig` / `AgentConfig` 类型
  - `AgentConfig.llm: LlmConfig` → `AgentConfig.llms: Record<string, LlmConfig>` + `AgentConfig.defaultLlm?: string`
  - `LlmConfig.model` 移除 → 新增必填 `LlmConfig.models: Record<string, LlmModelConfig>`
  - 新增 `LlmModelConfig` 类型（model 级透传字段，覆盖 provider 级同名字段）
  - **移除 `AgentConfig.defaultTools`** —— tool 引用列表只在每个 agent 自身的 `config.tools` 里显式声明（显式优于隐式，不再有全局共享 tool）

  旧：

  ```ts
  agent: { llm: { provider: 'openai', apiKey: '...', model: 'gpt-4o' }, defaultTools: ['weather.getWeather'] }
  ```

  新：

  ```ts
  agent: {
    llms: {
      openai: { provider: 'openai', apiKey: '...', models: { 'gpt-4o': {}, 'gpt-4o-mini': { temperature: 0.5 } } },
    },
    defaultLlm: 'openai',
  }
  ```

  ### `@faapi/agent` — `AgentRunOptions` 与 key 解析
  - `AgentRunOptions.provider: LLMProvider` 移除
  - `AgentRunOptions.model` 改为字符串 key，支持三种形式：
    1. llms 的 key 精确匹配（如 `'openai'`）—— 切到该 provider + 其 `models` 第一个 key
    2. `provider/model` 一体化（如 `'openai/gpt-4o'`）—— 精确切换 provider + model
    3. 纯 model 名（如 `'gpt-4o'`）—— 在所有 provider 的 `models` 里查找，唯一时切到对应 provider；歧义时抛 `AgentError`
  - `AgentDeps` 改为 `providers: Map<string, LLMProvider>` + `defaultProvider` + `llms` + `defaultLlm`
  - `AgentRuntimeConfig.defaultTools` 移除，`buildToolDefinitions` 只合并 `resolveAgentTools` + sub-agent（不再读全局 defaultTools）
  - `plugin.ts` setup 时遍历 `config.agent.llms` 每项调 `createProvider` 存 Map
  - `openai.ts` 实现 provider 级 + model 级字段合并（model 级覆盖 provider 级同名）

- 把 `AgentMetadata` / `ToolMetadata` 拆分为 LLM 可见核心层与代码加载详情层，并清理 `hasConfig` 死链路。DB-driven skill 接入进一步简化，不再需要占位字段。

  ## 破坏性变更（类型收窄，提供替代 API）

  ### `@faapi/faapi`
  - `agentRegistry.getAgent(name)` 返回类型从 `AgentMetadata | undefined` 收窄为 `AgentCore | undefined`（不含 `filePath` / `hasRun`），新增 `agentRegistry.getAgentEntry(name)` 返回 `AgentMetadata | undefined`（含代码加载细节，仅查文件 registry，**不 fallback** skillRegistry）
  - `loadAgentModule` 签名从 `(filePath, hasConfig, hasRun)` 简化为 `(filePath, hasRun)`——`hasConfig` 字段已移除（`AgentModule.config` 是死链路，`executeSubAgent` 拿到 `mod.config` 后从不读取）
  - `AgentModule` 接口移除 `config` 字段，仅保留 `{ run }`
  - `scanAgents` 不再检测 `config` 导出（删 `CONFIG_EXPORT_RE` + `hasConfig`），但 `extractAgentMetadata` 在 AST 阶段仍会查找 config 导出（提取 JSDoc 描述 + config 块字面量字段）
  - `faapi-agents.js` 产物（`SerializedAgentRecord`）移除 `hasConfig` 字段
  - `skillRegistry` 改存 `AgentCore` 而非 `AgentMetadata`——业务方 DB 记录只需映射 LLM 可见字段，无需 `filePath: ''` / `hasConfig: false` / `hasRun: false` 占位

  ### `@faapi/agent`
  - `AgentDeps` 新增 `getAgentEntry: (name: string) => AgentMetadata | undefined` 访问器
  - `Agent.executeSubAgent` 改用 `getAgentEntry`（而非 `getAgent`）拿 `AgentMetadata` 后调 `loadAgentModule`——因为 `getAgent` 现在返回 `AgentCore`（无 `filePath` / `hasRun`），且会 fallback 到 skillRegistry（DB skill 无文件可加载）
  - `plugin.ts` setup 时注入 `getAgentEntry` 访问器

  ## 新增类型导出
  - `AgentCore` —— LLM 可见字段层（`name` / `description` / `systemPrompt` / `tools` / `agents` / `model` / `maxTurns`），文件型 agent 与 DB-driven skill 都实现此接口
  - `AgentMetadata extends AgentCore` —— 额外含 `filePath` / `hasRun`，仅文件型 agent 实现
  - `ToolCore` —— LLM 可见字段层（`name` / `description`）
  - `ToolMetadata extends ToolCore` —— 额外含 `filePath` / `functionName` / `inputTypeName`

  ## 设计动机

  之前 `AgentMetadata` 把 LLM 可见字段（`systemPrompt` / `tools` / `model` 等）和代码加载细节（`filePath` / `hasRun` / `hasConfig`）混在一个接口里。DB-driven skill 无源文件，只能填 `filePath: ''` / `hasConfig: false` / `hasRun: false` 占位——字段污染、语义模糊。

  拆分后：

  - **`AgentCore`** 描述「agent 是什么」（LLM 看到的部分），文件型 agent 与 DB skill 都实现，`getAgent` 返回此类型
  - **`AgentMetadata`** 描述「agent 怎么加载」（`filePath` / `hasRun`），仅文件型 agent 实现，`getAgentEntry` 返回此类型

  `ToolCore` / `ToolMetadata` 同构拆分，为未来 DB-driven tool 预留对称扩展点。

  `hasConfig` 是死链路：`scanAgents` 检测后存入 `AgentManifest.hasConfig` → `extractAgentMetadata` 透传到 `AgentMetadata.hasConfig` → `loadAgentModule` 用它决定是否提取 `mod.config` → `executeSubAgent` 拿到 `mod.config` 后从不读取。整条链路终点无人消费，故移除。

  ## 迁移指南
  - 业务方 handler 直接 `import type { AgentMetadata }` 改为 `import type { AgentCore }`（如只读 LLM 可见字段）
  - DB skill 接入代码删除 `filePath` / `hasConfig` / `hasRun` 占位字段
  - 直接调 `loadAgentModule` 的代码去掉 `hasConfig` 参数（业务方一般不直接调）
  - 消费 `agentRegistry.getAgent` 返回值的 `filePath` / `hasRun` 字段的代码改用 `getAgentEntry`

## 3.0.0

### Major Changes

- 1d54523: 初始化 `@faapi/agent` 子包——faapi 的 agent 运行时。

  在 faapi 核心包已扫描的 `faapi-agents.js` + `faapi-tools.js` 清单之上提供 LLM 驱动的 ReAct 循环、tool calling、sub-agent 递归与流式输出。

  Phase 3.1：包骨架初始化（按 [AGENTS.md 6.5](../../AGENTS.md) 清单配置 package.json / tsconfig / tsup / vitest / LICENSE / README）。后续阶段将依次实现 LLM Provider 接口、reactLoop 循环引擎、Agent 类与 faapi 核心集成。

### Minor Changes

- 1d54523: Add multi-agent demo fixtures + e2e test: validates the full pipeline from fixture compilation (routes + agents + tools + config artifacts) through `createProdApp` registry hydration to `agent.run()` executing weather tool calls and writer sub-agent recursion via `app.inject()`.
- 1d54523: Agent handle factory integration: @faapi/agent plugin now registers a factory that injects a real Agent instance into handler `agent` parameter.

  - @faapi/faapi: export `registerAgentHandleFactory` / `clearAgentHandleFactory` / `AgentHandleFactory` from injection/agentHandle; export registry accessors (`getAgent`, `getTool`, `resolveAgentTools`, `resolveSubAgents`) and loaders (`loadAgentModule`, `loadToolModule`) for plugin consumption; `injectParams` `agent` parameter now calls `getAgentHandle(ctx)`; `createAppBase.close()` clears agent handle factory.
  - @faapi/agent: add `AgentHandle` interface (Agent satisfies it structurally); add default export faapi plugin that reads `config.agent.llm` + `config.agent.defaultAgent`, creates LLM provider, and registers agent handle factory wiring real registry/loader accessors into `AgentDeps`.

- 1d54523: Tool input schema resolution: agents now dynamically load each tool's `zod.js` to validate LLM-provided arguments before invoking the tool handler.

  - @faapi/faapi: add `loadToolSchema` (loader/loadToolSchema.ts) that dynamically imports a tool's `zod.js` and returns the schema object + schema name; export `loadToolSchema` and `ToolSchemaModule` from the public entry.
  - @faapi/agent: implement `AgentDeps.resolveToolSchema` in the plugin — loads the tool schema via `loadToolSchema`, generates a JSON Schema with `z.toJSONSchema` for the LLM, and validates tool arguments via `schema.safeParse`; on validation failure returns `{ error }` (handler not called) so the react loop can feed the error back to the LLM for retry; missing `zod.js` falls back to free-form `{ type: 'object' }` schema.

- 49d7ac9: Agent 性能优化与死代码清理:

  - @faapi/faapi: 删除 `scanAgents` / `scanTools` 的未使用 `_dist` 参数（参数名带 `_` 前缀，文档已注明未使用，所有调用方均不传）；同步修复 agent 相关文档与代码不一致
  - @faapi/agent: Agent 类新增 tool schema 实例级缓存（`getToolSchema`），避免 `buildToolDefinitions` 与 `executeTool` 重复调用 `resolveToolSchema`；plugin.ts 提取 `resolveToolSchemaImpl` 为模块级函数，setup 内创建偏函数一次，工厂内复用，避免每次请求重建闭包

### Patch Changes

- Updated dependencies [1d54523]
- Updated dependencies [1d54523]
- Updated dependencies [49d7ac9]
  - @faapi/faapi@3.0.0
