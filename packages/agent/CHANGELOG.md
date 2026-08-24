# @faapi/agent

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
