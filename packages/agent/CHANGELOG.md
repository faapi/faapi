# @faapi/agent

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
