# @faapi/faapi

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

- 新增 `skillRegistry`,支持业务方在 plugin 里把数据库 / 外部源加载的 skill 动态注册,运行时与文件型 agent 共享同一调用链路。

  ## 新增能力

  ### `@faapi/faapi` — `skillRegistry` + agentRegistry fallback
  - 新增 [skillRegistry](https://github.com/faapi/faapi/blob/main/packages/faapi/src/injection/skillRegistry.ts) 模块,与 `agentRegistry` 物理隔离,承载 DB-driven skills(业务方在 plugin 里从数据库 / 外部源加载的 skill 元数据)
  - 新增导出:`hydrateSkillRegistry` / `upsertSkill` / `removeSkill` / `getSkill` / `listSkills`(从 `@faapi/faapi` 顶层导出,业务方 plugin 直接 import)
  - `agentRegistry` 查询函数(`getAgent` / `listAgents` / `resolveAgentTools` / `resolveSubAgents` / `asTool`)在文件 registry 未命中(或被覆盖)时 fallback 到 `skillRegistry`,**优先级:skill 优先 → 文件型回退**
  - `createAppBase` close 流程新增 `clearSkillRegistry` 清理,与 `clearAgentRegistry` 对称

  ### 设计决策:为什么双 registry 而非同表合并
  - `agentRegistry.hydrateAgentRegistry` 是**整体替换**语义——agent 清单来自编译期产物 `faapi-agents.js`,dev 模式 watcher 每次改文件都触发整体重新水合。若 DB skill 混在同一 registry 会被清空,业务方需要手动重塞,不可接受
  - DB skill 是**运行时增量**——业务方监听 DB change stream 单条增删改,与"整体替换"语义天然冲突
  - **同名 override**——业务方可在 DB 里覆盖文件型 agent 的 `systemPrompt` / `tools`,物理隔离比同表 name 冲突规则更清晰

  ### DB skill 字段约定

  DB 记录转 `AgentCore` 时:

  - `name` / `description?` / `systemPrompt?` / `tools?` / `agents?` / `model?` / `maxTurns?` 由 DB 字段直接映射（仅 LLM 可见字段）
  - 无需 `filePath` / `hasRun` 等代码加载占位——这些属于 `AgentMetadata`，仅文件型 agent 实现，DB skill 不实现该接口

  ### 接入示例

  业务方写一个本地 plugin 桥接 DB → skillRegistry:

  ```ts
  // plugins/db-skills.ts
  import { hydrateSkillRegistry, upsertSkill, removeSkill, type AgentCore } from '@faapi/faapi';
  import type { FaapiPlugin } from '@faapi/faapi';

  export default {
    setup({ config }) {
      config.lifecycle = config.lifecycle ?? {};
      config.lifecycle.onReady = async () => {
        // 启动期全量灌入
        const skills = await loadAllSkillsFromDb();
        hydrateSkillRegistry(skills.map(toCore));

        // 运行时增量更新(监听 change stream)
        watchSkillChanges({
          onUpsert: (s) => upsertSkill(toCore(s)),
          onRemove: (name) => removeSkill(name),
        });
      };
    },
  } satisfies FaapiPlugin;
  ```

  ## 兼容性
  - 纯新增,无破坏性变更
  - 未使用 DB skill 的项目无感知:skillRegistry 默认空,`getAgent` fallback 不命中,行为与改动前一致
  - `@faapi/agent` 子包的 `Agent` 类、`AgentHandleFactory`、`injectParams` 都通过 `agentRegistry` 查询函数自动消费 fallback 结果,无需改造

  详见 [AGENTS.md §5.6.3 双 registry 设计](https://github.com/faapi/faapi/blob/main/AGENTS.md) 与 [src/injection/skillRegistry.md](https://github.com/faapi/faapi/blob/main/packages/faapi/src/injection/skillRegistry.md)。

- 修复错误处理语义 + 中间件加载可见性 + 响应格式集中化 + dev on demand 状态封装

  ## 新增
  - 新增 `PayloadTooLargeError`（413），由 `createServer` 的 `limitStreamSize` 在请求体超限时抛出。原先静默兜底为 500 `INTERNAL_ERROR`，语义错误——现经由 `formatErrorResponse` 命中 `PayloadTooLargeError` 分支，返回 413 + `PAYLOAD_TOO_LARGE` 业务码。
  - 新增 `errorCodes.PAYLOAD_TOO_LARGE` 错误码常量。
  - 新增 `response/responseFormatter.ts`：集中所有响应格式逻辑（`defaultOk` / `defaultFail` / `resolveOkFn` / `resolveFailFn` / `jsonOk` / `wrapOkResult` / `formatFailResponse` / `formatErrorResponse`），让 handler return 自动包裹、ctx.fail() 主动错误响应、formatErrorResponse 抛错兜底 三条路径共享同一套 ok/fail 函数。
  - `compileOnDemand` 新增 `_resetDevOnDemandState()`（仅测试用），便于测试隔离。

  ## 修复

  ### `limitStreamSize` 健壮性
  - `reader.read()` 抛错（客户端断开、底层流异常）现通过 `failStream` 兜底 `controller.error` + 释放 reader lock，避免悬挂引用
  - 触发超限后通过统一的 `failStream` 路径处理，状态机一致
  - 错误消息改为英文 + 字节数（之前是硬编码中文），便于 i18n
  - `cancel` 回调释放上游 reader lock

  ### 中间件加载失败可见性

  `loadMiddlewaresFile` 在文件 import 抛错时（语法错误 / 路径不存在 / 运行时抛错）改为 `console.error` 输出原始错误堆栈，不再静默吞没——鉴权等关键中间件失效若完全无感知，等同于服务裸奔。仍返回空 bundle 保证服务可启动，业务方可由 `onError` 钩子感知，dev 期 watcher 自愈。

  ### `formatErrorResponse` 现读取 `config.response.fail`

  原先 `formatErrorResponse` 不读业务方自定义 fail 函数——`ctx.fail()` 主动错误响应用业务方 fail 函数,但 handler 抛错兜底走框架默认 fail,两条错误路径的响应格式可能漂移。现在 `formatErrorResponse(err, config?)` 接受可选 config 参数,与 `formatFailResponse` 共享同一套 fail 函数,业务方自定义 fail 函数自动应用到所有错误响应,无需在两处分别定义格式。`serverUtils.buildErrorResponse(err, config)` 跟着改签名,`createServer.sendErrorResponse` 传 `ctx.config`。

  ## 重构

  ### `formatErrorResponse` 统一用 `jsonOk` 构造响应

  原先 4 个分支重复 `new Response(JSON.stringify(body), { status, headers: {...} })`，现统一改用 `responseFormatter.jsonOk(body, status, extraHeaders?)` 构造，新增 `PayloadTooLargeError` 分支共享同一构造路径。集中化后所有响应构造通过 `jsonOk` 完成，无重复内联代码。

  ### `createServer.handleRequest` 拆分

  原先 `handleRequest` 约 130 行承担请求转换 / 路由匹配 / 404-405 / 中间件加载 / 注入器合并 / handler 调用 / 错误兜底多职责。现拆分为 4 个职责单一的函数：

  - `prepareRequest(req, config, bodyLimit)` —— Node IncomingMessage → Web Request + FaapiContext
  - `resolveRouteOrThrow(routes, method, urlPath)` —— 路由匹配，未命中抛 `RouteNotFoundError` / `MethodNotAllowedError`
  - `createRoutePipeline(...)` —— 路由执行管线（作为外层中间件链的 finalHandler）
  - `sendSuccessResponse` / `sendErrorResponse` —— 响应发送 + `onError` 副作用触发

  主流程 `handleRequest` 现仅 40 行，每个步骤带数字注释，可读性显著提升。

  ### `createContext` / `invokeHandler` 共享 `responseFormatter`

  原先 `invokeHandler.wrapResult` 和 `createContext.ok` / `ctx.fail` 各自实现默认 ok/fail 函数(`((d) => ({ data }))` 等),存在重复定义。现全部委托给 `responseFormatter.wrapOkResult` / `formatFailResponse`,确保响应格式在所有路径一致。

  ### `compileOnDemand` 状态封装 + 并发去重（mutex）

  原本散落的 4 个模块级可变状态(`devOnDemandEnabled` / `devDistDir` / `compiledFiles` / `generatedSchemas`)封装到 `DevOnDemandState` 单例对象,避免全局污染 + 便于测试隔离。同时新增 in-flight Promise Map 做 mutex:

  - `ensureCompiled`: 同一 sourceAbsPath 的并发请求共享同一 in-flight Promise,避免重复触发 esbuild
  - `ensureSchemaGenerated`: 同一 schemaPath 的并发请求同理
  - watcher 触发 `clearCompiledFiles` / `clearGeneratedSchemas` 时同步清空 in-flight Map,避免旧 Promise 永久阻塞
  - 失败语义: 第一个请求编译失败时,第二个请求 `await` 会捕获但不抛错,让自己按正常流程重试

  ## 文档
  - 新增 `src/response/responseFormatter.md` DDD 文档
  - 更新 `src/errors/formatErrorResponse.md` 为 re-export 入口说明
  - 更新 `src/response/README.md` 加入 responseFormatter 模块条目
  - 更新 `src/cli/compileOnDemand.md` 补 DevOnDemandState 封装 + mutex 章节
  - 更新 `AGENTS.md` 5.5 节加错误响应三路径流程图 + 自定义 Error 注意事项;6.2 节加 413 状态码 + 中间件加载失败语义

## 3.0.0

### Minor Changes

- 1d54523: Agent handle factory integration: @faapi/agent plugin now registers a factory that injects a real Agent instance into handler `agent` parameter.

  - @faapi/faapi: export `registerAgentHandleFactory` / `clearAgentHandleFactory` / `AgentHandleFactory` from injection/agentHandle; export registry accessors (`getAgent`, `getTool`, `resolveAgentTools`, `resolveSubAgents`) and loaders (`loadAgentModule`, `loadToolModule`) for plugin consumption; `injectParams` `agent` parameter now calls `getAgentHandle(ctx)`; `createAppBase.close()` clears agent handle factory.
  - @faapi/agent: add `AgentHandle` interface (Agent satisfies it structurally); add default export faapi plugin that reads `config.agent.llm` + `config.agent.defaultAgent`, creates LLM provider, and registers agent handle factory wiring real registry/loader accessors into `AgentDeps`.

- 1d54523: Tool input schema resolution: agents now dynamically load each tool's `zod.js` to validate LLM-provided arguments before invoking the tool handler.

  - @faapi/faapi: add `loadToolSchema` (loader/loadToolSchema.ts) that dynamically imports a tool's `zod.js` and returns the schema object + schema name; export `loadToolSchema` and `ToolSchemaModule` from the public entry.
  - @faapi/agent: implement `AgentDeps.resolveToolSchema` in the plugin — loads the tool schema via `loadToolSchema`, generates a JSON Schema with `z.toJSONSchema` for the LLM, and validates tool arguments via `schema.safeParse`; on validation failure returns `{ error }` (handler not called) so the react loop can feed the error back to the LLM for retry; missing `zod.js` falls back to free-form `{ type: 'object' }` schema.

- 49d7ac9: Agent 性能优化与死代码清理:

  - @faapi/faapi: 删除 `scanAgents` / `scanTools` 的未使用 `_dist` 参数（参数名带 `_` 前缀，文档已注明未使用，所有调用方均不传）；同步修复 agent 相关文档与代码不一致
  - @faapi/agent: Agent 类新增 tool schema 实例级缓存（`getToolSchema`），避免 `buildToolDefinitions` 与 `executeTool` 重复调用 `resolveToolSchema`；plugin.ts 提取 `resolveToolSchemaImpl` 为模块级函数，setup 内创建偏函数一次，工厂内复用，避免每次请求重建闭包

## 2.0.1

### Patch Changes

- 153f785: 修复 `getApp()` 在 Next.js 16 + `@faapi/next` dev 模式下抛 "No app instance" 的问题。

  将 app 单例从模块级变量改为 `globalThis` + `Symbol.for('faapi.app.instance')` 存储。

  **根因**：Next.js 16 默认用 Turbopack 作为 `next dev` 的 bundler，Turbopack dev server runtime 与主进程的 Node.js 原生 module cache 是两套独立缓存。即使配置了 `serverExternalPackages: ['@faapi/faapi']`，RSC chunk 在运行时仍通过 Turbopack runtime 加载 `@faapi/faapi`，得到的是另一个模块实例，模块级变量 `currentApp` 无法跨实例共享，导致 RSC 中 `getApp()` 读到的永远是 `null`。

  **影响范围**：仅 dev 模式（`faapi dev` + `next dev: true`）。生产模式（`node dist/main` + `next build`）不受影响——`next build` 虽然用 Turbopack 编译，但产物是普通 JS 文件，运行时通过 Node.js 原生 `require` 加载，external 包命中主进程 module cache，与主进程是同一个模块实例。

  用 `globalThis` 存储后，无论通过哪个模块实例加载，都能读到同一个 app 引用，使 `@faapi/next` 插件集成的 RSC 场景在 dev 模式下正常工作（生产模式本来就不受影响，此修复对生产模式无副作用）。

## 2.0.0

### Major Changes

- 1258e39: 新增 `@faapi/faapi/testing` 子路径，聚合所有测试 API 导出；新增 `createTestContext` 测试专用语法糖。

  ## 新增 `@faapi/faapi/testing` 子路径

  测试 API 从主入口 `@faapi/faapi` 拆分到独立子路径 `@faapi/faapi/testing`，与生产代码导入分离：

  ```ts
  // 之前
  import { createTestContext, invokeHandler, createTestServer, connectWs } from '@faapi/faapi';

  // 现在
  import {
    createTestContext,
    invokeHandler,
    createTestServer,
    connectWs,
  } from '@faapi/faapi/testing';
  ```

  `@faapi/faapi/testing` 导出：
  - 轻量测试：`createTestContext`、`invokeHandler`
  - E2E 测试：`createTestServer`、`connectWs`、`MessageQueue`、`waitForWsOpen`
  - 类型：`TestServer`、`TestServerOptions`、`WsTestClient`、`WsTestClientOptions`、`CreateTestContextOptions`、`FaapiContext`、`FaapiMiddleware`、`InjectorMap`

  主入口 `@faapi/faapi` 不再导出测试 API（`createContext` 仍为公开运行时 API，供运行时同构场景使用）。

  ## 新增 `createTestContext` 测试专用语法糖

  免去手写 `new Request('http://localhost/...')` 的样板代码：

  ```ts
  import { createTestContext } from '@faapi/faapi/testing';

  const ctx = createTestContext({
    method: 'POST', // 默认 'GET'
    path: '/api/user', // 必填，无需写 host
    query: { page: 1, tags: ['a', 'b'] }, // 对象形式，自动拼接 URL（数组生成同名多值参数）
    headers: { authorization: 'Bearer xxx' }, // 请求头对象
    params: { id: '123' }, // 动态路由参数，默认 {}
    config: { db: { host: '...' } }, // 业务配置，默认 {}
    ip: '1.2.3.4', // 客户端 IP，默认 ''
  });
  ```

  **设计要点**：

  - `createContext(request, ...)` 签名不变，保持运行时与测试同构——运行时 `createServer` 也从真实 HTTP 请求构造 Request 调用它
  - `createTestContext` 是纯测试便捷封装，内部构造 Request 调 `createContext`，不引入运行时分支
  - **不接受 body 选项**：`createContext` 本身不读 `request.body`，body 注入由 `invokeHandler` 第 3 参数负责。POST/PUT/PATCH 测试时 body 单独传给 `invokeHandler`，避免在两处传 body 产生混淆
  - query 支持 string/number/boolean 及数组（数组生成同名多值参数）

  **效果对比**：

  ```ts
  // 之前：手写完整 URL + 拼 query 字符串
  const ctx = createContext(
    new Request('http://localhost/api/user?page=1&pageSize=10'),
    {},
    { db: { host: '...' } },
  );

  // 现在：对象形式，无样板代码
  const ctx = createTestContext({
    path: '/api/user',
    query: { page: 1, pageSize: 10 },
    config: { db: { host: '...' } },
  });
  ```

  ## 破坏性变更

  测试 API（`createTestContext`、`invokeHandler`、`createTestServer`、`connectWs`、`MessageQueue`、`waitForWsOpen`）从主入口 `@faapi/faapi` 移除，改从 `@faapi/faapi/testing` 导入。业务方需将测试文件中的 import 路径从 `@faapi/faapi` 改为 `@faapi/faapi/testing`。

  同步更新文档：AGENTS.md 5.10、`src/runtime/createContext.md`、`src/testing.md`、技能文档 `.trae/skills/faapi-dev/testing.md`；框架自身 5 个测试文件改用 `createTestContext`。

## 1.5.0

### Minor Changes

- 新增 `getApp()` 函数 + 修复 `app.inject()` 的 POST body bug，支持 Next.js Server Component 同进程调用。

  ## 新增 `getApp()`

  获取当前 faapi app 单例。用于在无法直接拿到 app 引用的场景（如 Next.js Server Component）中访问 app。

  - 未初始化时抛错（强约束）
  - `createAppBase` 末尾设置单例，`close()` 时清 null

  ```ts
  // Next.js RSC 中同进程调用 faapi API（避免 HTTP loopback）
  import { getApp } from '@faapi/faapi';
  import { headers } from 'next/headers';

  const app = getApp();
  const res = await app.inject({
    method: 'GET',
    path: '/api/user',
    headers: { cookie: (await headers()).get('cookie') ?? '' },
  });
  const data = res.body; // 已解析
  ```

  ## 修复 `app.inject()` 的 POST body bug

  `inject` 内部用 `PassThrough` 构造 mock 请求流，`read()` 钩子立即 `push(null)` 表示 EOF，之后 `push(body)` 无效——导致 POST 请求 body 丢失、handler 永久等待。

  修复：改用 `Readable.from([Buffer.from(JSON.stringify(body))])`，异步迭代器与 `Readable.toWeb(req)` 正确配合。

## 1.4.0

## 1.3.1

### Patch Changes

- 补充 invokeHandler 的 ctx.ok / ctx.fail 单元测试覆盖：自动包裹、与 return data 一致性、Response 不被再次包裹、合并 setStatus/setHeader、自定义 config.response.ok/fail、status 与 code 独立可省略（无推导关系）、中间件组合（放行/拦截/try-catch 后用 ctx.fail）。同步 faapi-dev 技能 testing.md：局限性表新增"不走 formatErrorResponse 兜底"行，并说明 handler 抛错时 re-throw 的设计原因（invokeHandler 接收函数而非 route，无法定位 zod.js）。

## 1.3.0

### Minor Changes

- 新增统一响应包装能力：ctx.ok / ctx.fail 便捷方法 + handler 返回值自动包裹

  - 新增 `ctx.ok(data)`：显式包裹成功响应，等价于 `return data`（框架自动包裹）
  - 新增 `ctx.fail({ status?, code?, message })`：返回错误响应，status 和 code 均可独立省略（无推导关系）
  - 新增 `config.response` 配置（`ok` / `fail` 可选）：自定义成功/错误响应包装结构
  - `invokeHandler.wrapResult` 自动包裹：handler return 非 Response 的值（含 null/undefined）时用 `config.response.ok`（默认 `(data) => ({ data })`）包裹
  - `Response` 对象原样透传，不被包裹（`ctx.ok`/`ctx.fail`/`ctx.json` 等返回的 Response 均属此类）

  **Breaking**：handler `return data` 的默认响应格式从原样返回变为 `{ data }` 包裹。如需原样返回，用 `return ctx.json(data)`。

## 1.2.1

### Patch Changes

- 修复 server 未 listen 时调用 app.close() 报 ERR_SERVER_NOT_RUNNING 的问题；修复 dev 按需编译在 vitest/CI 环境下首次 import 失败导致 500 的问题（改为先 ensureCompiled 编译再 import）。

## 1.2.0

### Minor Changes

- Vite 风格按需编译与中间件按需加载

  - dev 模式启动时只编译 config + 生成路由清单，handler.js / zod.js 在首次请求时才触发编译/生成（三层 mtime 缓存复用未变更产物）
  - scanRoutes 改为正则提取方法名（零 import handler.js），中间件改为收集路径不预加载
  - 中间件加载延后到首次请求阶段（dev/prod 通用），hydrateRoutes 只传递 middlewarePaths，createServer / handleWsUpgrade 按需调用 loadMergedMiddlewares
  - watcher 热替换时清缓存（clearCompiledFiles / clearGeneratedSchemas / invalidateMiddlewareCache），下次请求按需重建
  - ensureCompiled / ensureSchemaGenerated 失败时抛错（不静默吞错），loadRouteModule 捕获并附加上下文

## 1.1.1

### Patch Changes

- 改进发布流程：通过 tag 区分 canary 和 stable 发布

## 1.1.0

### Minor Changes

- 853a175: 新增 `ua` 注入类型：handler 可通过 `ua` 参数名注入客户端 User-Agent（请求头 `user-agent` 原值），`ctx.ua` 字段可直接访问。与 `ip` 对称，UA 在 `createContext` 内联从请求头读取（无需调用方传入），HTTP 与 WebSocket 握手均自动支持。

## 1.0.2

### Patch Changes

- `createTestServer` 在 vitest 环境下自动走 Vite SSR pipeline，识别 TypeScript paths 别名 + 让 `vi.mock` 生效。

  ## 问题

  业务方在 vitest 下用 `createTestServer` 启动 in-memory 测试服务器时，handler 内 `import { db } from '@/lib/db'` 报 `Cannot find package '@/lib'`——`createTestServer` 内部 `importWithCacheBust` 用 Node 原生 `import()` 加载 handler，Node 原生 ESM 不识别 tsconfig paths 别名，也不让 `vi.mock` 生效（mock 只在 Vite module pipeline 内有效）。

  ## 修复

  `importWithCacheBust` 检测 `globalThis.vi.importActual`（vitest `globals: true` 时注入），优先走 Vite SSR pipeline：
  - 识别 `vitest.config.ts` 的 `resolve.alias` 与 tsconfig paths 别名
  - 让 `vi.mock` 在加载的 handler 内生效

  非 vitest 环境回退到 Node 原生 `import()`，无副作用。

  ## 业务方前置

  `vitest.config.ts` 设 `test.globals: true`（推荐），或测试文件内显式 `import { vi } from 'vitest'` 后挂到 `globalThis.vi`。

## 1.0.1

### Patch Changes

- 新增 E2E 测试 API：公开导出 `createTestServer` / `connectWs` / `MessageQueue` / `waitForWsOpen`，业务方一行代码启动带 schema 校验的真实端口测试服务器，并便捷测试 WebSocket 路由。

  - `createTestServer(options)`：内部自动 scanRoutes + mkdtemp + generateSchemaFiles + createServer + listen(0)；`close()` 自动 closeAllConnections + 清理 schema 目录 + invalidateSchemaCache
  - `connectWs(baseUrl, pathname, options?)`：解决 WS 测试三大痛点——open/message 监听竞态、三事件监听 + 超时清理、http→ws 协议转换；失败时主动 `ws.close()` 避免资源泄漏
  - `MessageQueue`：FIFO 缓冲早到消息 + Promise 化 `next(timeout)`；支持 Buffer/Buffer[]/ArrayBuffer 多种消息形态
  - `waitForWsOpen(ws, timeout?)`：Promise 化等待 `open` 事件，监听 open/error/close 并清理

  默认禁用 CORS/Helmet/Logger 避免污染断言；与 `createProdApp + app.inject` 互补——`createTestServer` 专注"真实端口 + 自动 schema"，无需 `faapi build` 即可测试 SSE/WS/CORS/真实 HTTP 头。

## 1.0.0

### Major Changes

- 首次发布 faapi——"函数即接口"的 Node.js API 框架。核心能力包括：基于 TypeScript AST 自动生成 zod schema 的类型校验、洋葱模型中间件、按参数名匹配的依赖注入、零入口设计（`faapi dev` / `faapi build` / `node dist/main`）、产物驱动架构（dev/prod 共享 `createAppBase`，无 `if (isDev)` 分支）、WebSocket 路由、SSE 流式响应、CORS/helmet/logger 内置中间件、tsconfig paths 别名、插件系统、业务方测试支持（`createContext`/`invokeHandler`）。多环境配置通过 `.env` 系列文件实现（参考 Next.js），启动时 `loadEnv` 加载到 `process.env`。

### Minor Changes

- `SseWriter` 新增 `sendRaw(chunk)` 方法，支持原始字节/字符串透传（不做 SSE 序列化）。适用于 LLM 中转平台场景——逐 chunk 透传上游已有的 SSE 原文，同时边透传边解析末尾 chunk 的 `usage` 字段落库。与 `send`（结构化事件序列化）互补，可混用。
- 将 `zod` 从 `dependencies` 改为 `peerDependencies`。框架生成的 `zod.js`（每个 handler 一个，运行时按需 import 做 `safeParse`）位于业务方项目目录，pnpm 严格 node_modules 布局下 `dependencies` 声明的 zod 被隔离在 `@faapi/faapi/node_modules/zod`，Node ESM 解析器从 `.faapi/**/zod.js` 向上查找 `node_modules/zod` 失败。改为 `peerDependencies` 后业务方项目根可解析到 zod。业务方需在项目 `package.json` 显式安装 `zod@^4`。

### Patch Changes

- 修复 dev watch 模式下偶发 `Cannot find package '@/lib'` 500 错误。根因：`compileDevRoutes` 用 esbuild 默认写文件（非原子），`rebuildRoutes` 期间 HTTP 请求可能读到写一半的产物（alias 未重写完）。修复：启用 esbuild `write: false`，拿到 `outputFiles` 后自行原子写（写临时文件 + `rename`，POSIX 原子）。仅 dev 需要（build 是一次性编译，运行时不并发）。
