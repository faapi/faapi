# HISTORY.md — 历史沿革、踩坑与存疑台账

本文件是项目中**唯一**记录三类内容的位置：

1. **曾经存在、现已移除的概念**（它是什么、由什么承接、为什么移除、哪个版本）
2. **踩坑 / 事故**（现行规则的来源——规则本体留在 AGENTS.md 或模块文档，事故叙述只在这里）
3. **存疑 / 待决事项**

现行文档（AGENTS.md、`packages/*/src/**/*.md`、源码注释）**只描述现状**，不保留「原 X 钩子 / 已移除 / 7.x 事件化」之类的历史尾巴与迁移指引；逐版本的行为变更明细在各包 `CHANGELOG.md`（changesets 生成，不手写）。

**维护时机**：删除公开概念、处置事故、产生待决事项时追加条目；条目了结（待决有结论）时就地更新结论，不删除。

---

## 1. 已移除概念台账

| 概念（曾经） | 现在由什么承接 | 为什么移除 | 版本 |
| --- | --- | --- | --- |
| `config.lifecycle` 四钩子 `onBoot` / `onReady` / `onClose` / `onError` | app 事件 `app:boot` / `app:ready` / `app:close` / `request:error`，在 `src/bootstrap.ts` 经 `getApp().on(...)` 订阅 | 流程扩展点统一为事件总线一种模型（原十二个散落口子各有声明面、传递链与错误约定） | 7.9.0 |
| 编程式启动入口 `createApp` / `createProdApp` / `createDevApp` 公开导出 + `onAppEvent` 订阅函数 | `$start` 唯一公开启动导出（仅供生成的 `dist/main.js`）+ `getApp().on` | 零入口唯一化——dev 由 CLI 编排、prod 由 build 生成入口；存量 `dist/main.js` 需重跑 `faapi build` | 7.9.0 |
| authHooks 三钩子 `config.agent.beforeToolCall` / `afterToolCall` / `filterTools` | `agent:before-tool-call` / `agent:after-tool-call` / `agent:filter-tools` 事件（见 `packages/agent/src/toolChainEvents.md`） | 同上（事件化） | 7.9.0 |
| deps 钩子 `resolveSystemPrompt` / `resolveSubAgentContext` | `agent:system-prompt` / `agent:sub-agent-context` 事件 | 同上 | 7.9.0 |
| deps 钩子 `resolveRootInput` / `resolveSubAgentInput` | `agent:root-input` 事件（7.9.0 起可写 `e.input`）→ 写面收敛为 `addInput`，与 `agent:input` 首轮共用暂存一起合并（7.12.0 之后） | 两套输入改写语义（整体替换 vs 片段落账）并存是等价路径；`{{rawInput}}` 占位符让片段即可拼出任意形态。**原「整体替换输入 / 丢弃原文」能力不再提供**——原输入恒在首条 user 消息中 | 7.9.0 → 7.12.0+ |
| `agent:input` 载荷 `messages` 可整体替换（改写仅作用本轮发送、不落历史） | `messages` 深冻结只读快照 + `addInput(text, index?)` 落账进历史 | 「发送副本改写不落历史」让 result.messages 与实际发送不一致；统一为 append-only 账本 | 7.11.0 |
| `trimHistory` 自动截断 + `agentConfig.historyCompactor` 策略位（`HistoryCompactor` / `HistoryCompactorInput` 导出、`historyCompaction` 模块） | `agent:history-over-budget` 事件 `replace(history)`；`maxHistoryTokens` 语义收敛为超限阈值 | 框架零内置裁剪——长度控制是业务知识 | 7.11.0 |
| agent 域事件载荷上的实体名字段（`agentName` / `name` / `subName`） | 专属名订阅 `agent:<event>:<实体名>`（名字在事件名里） | 「载荷字段分流」与「专属名订阅」两条等价路径并存造成使用困惑 | 7.10.0 |
| `config.task.onFailed` 钩子 | `task:failed` 事件 | 事件化 | 7.9.0 |
| agent 自定义 `run` 导出（含 `loadAgentModule` / `AgentModule` / `hasConfig` / `hasRun` 公开 API） | 声明式 `config` + 默认 reactLoop；编排代码注册为 tool；多 agent 协作用 `config.agents`。`run` 导出不被读取 | 自定义 run 绕过 schema 校验 / trace / 事件守卫，不可观测 | 6.24.0 |
| agent `config.model`、全局 `defaultAgent` / `defaultLlm` | `agent.run(input, { agent, model })` 调用侧显式指定（config.model 声明撞「未知 config 字段」白名单通用报错）；sub-agent 派发沿用父解析结果 | 模型档位是调用侧决策，不属于 agent 声明 | 7.2.0（config.model）；defaultAgent/defaultLlm 更早 |
| 构建期 TS AST 提取 agent `config` 字面量进 `faapi-agents.js` 数据清单 + `@agent` JSDoc 覆盖名 | 运行时启动期求值（`loadAgents`），清单仅做定位；agent 名由目录推导（残留标签静默忽略） | 字面量提取挡住动态需求（按 env/DB 切人设被迫绕道全局面） | 6.45.0（覆盖名）/ 7.6.0（运行时求值） |
| `@tool` JSDoc 覆盖名 | tool 名 = 目录路径 + 函数名推导（嵌套段 `_` 连接）；残留标签静默忽略 | 覆盖名让注册名与目录结构脱钩 | 6.45.0 |
| sub-agent 派发工具名 `agent.<name>` 点号前缀；tool 嵌套名 `.` 连接 | `agent-<name>`（`subAgentToolName`）；`_` 连接 | OpenAI 兼容协议硬约束 `^[a-zA-Z0-9_-]+$`，强校验上游（DeepSeek / OpenAI）整单 400 | 6.28.0 |
| `skillRegistry`（DB-driven skill 注册表：`hydrateSkillRegistry` / `upsertSkill` / `removeSkill` / `getSkill` / `listSkills`） | 不进框架注册表——业务自建「实时查库 + LLM 可见花名册 + tool 按需读取」 | 「全局共享、名键唯一」的 skill 模型不成立（技能天然是用户 / 租户维度） | 6.47.0 |
| `AgentRuntimeConfig.defaultTools` 全局共享 tool 合并 | `buildToolDefinitions` 只合并 agent 自身 tools + sub-agent | 全局面与 per-agent 声明重叠 | 3.1.0 |
| 内置 `memory` 任务驱动 | `@faapi/task-pgboss` / `@faapi/task-bullmq`（`'memory'` 按未知驱动报错） | 框架不提供「可丢任务」的进程内实现 | 6.4.0 |
| 隔离任务 6 种 per-behavior RPC 垫片（`beforeToolCall` / `toolCall` / `filterTools` / `resolveSubAgentInput` / `resolveSubAgentContext`……「IO 在 worker、CPU 在宿主」） | 单次 `agent-run` RPC 收敛宿主执行完整循环（`taskCtx.agent` 为 run-only 句柄） | 业务函数面不跨线程，db 等资源单实例 | 7.6.0 |
| 隔离任务 config 的 `safeConfig` JSON 快照 | 先改为隔离任务不传 config（6.33.0），后以 `collectConfigSnapshot` 纯数据投影承接（函数值不进快照，不可克隆值显式报错） | JSON 快照把 Date 变字符串、静默丢字段 | 6.33.0 → 6.44.0 |
| 进程内任务用 `timeoutMs` 字段隐式判定「隔离执行」 | 文件名判据：`task.ts` 进程内 / `worker.ts` 隔离；`task.ts` 声明超时字段构建期报错附改名指引 | 运行时语义不该由可选字段有无隐式决定 | 6.44.0 |
| 各上下文的 `resourcesDir` 数据字段（FaapiContext / WsContext / TaskContext / PluginContext / AppBase / 事件载荷）+ `AgentDeps.resourcesDir` | 唯一读取入口 `readResource(relativePath)`（越界 / `..` / 符号链接逃逸抛错） | 暴露路径助长 `path.join` + `fs.readFile` 的无防护绕行读法 | 6.25.0 / 6.27.0（6.29.0 补删 AppBase） |
| 多 app 同进程 | 单进程单 app，`createAppBase` 检测到存活 app 抛错 | 单例语义、全局日志、`readResource` 绑定都以唯一 app 为前提 | 6.25.0 |
| `config.logger` 独立请求日志配置 + 「日志调用永不抛错」契约 | `config.log` 单一入口（egg 模型：请求日志无条件并入同一管道，`accessLog: false` 关闭）；fields 结构错误 `TypeError` 冒泡 | 两套配置面重叠；坏 fields 属业务数据缺陷，显式失败 | 6.10.0 |
| 注册表模块级全局单例 + `hydrate` 整体替换 | app 实例级 `AppRegistries`（全局函数 `getTool` / `listAgents` 等为默认实例便捷访问器，与 app 实例无关） | 后创建的 app 覆盖先前注册、生命周期与 app 脱钩 | 4.0.0 |
| `AgentPathMeta` 类型 | 删除（与 `AgentManifest` 同构）；`AgentCore` / `AgentMetadata` 迁至 `agents/agentTypes.ts` | 同构类型重复 | 7.6.0 |
| `toolSchemaResolver` 实现位于 `@faapi/agent` | 下沉主包 loader 域（`packages/faapi/src/loaders/toolSchemaResolver.ts`），`@faapi/agent` 保留 `ToolSchemaResolution` 类型 re-export | zod 同源、测试设施共用 | — |
| `toProdExtension` 由 `cli/aliasPlugin.ts` 导出 | `utils/prodPaths.ts`（兼容 re-export 已随本台账建立一并删除） | 产物路径规则单一实现 | — |
| 从未导出的 `startServer()` 启动函数 | `createAppCore` 统一编排（`startServer.ts` 文件名保留为历史路径，仅承载 listen 工具函数） | 与 `createServer` 功能子集漂移、listen 无 reject | 6.18.0 |
| 静态文件服务 | 不提供——生产用 CDN / Nginx 等专用服务 | 非框架职责 | — |
| `fallback.md` 降级台账 | 删除；禁止降级规则见 AGENTS.md 5.6.4，九条历史处置见本文件第 2 节末 | 维护者决策：本框架不允许降级 | 6.33.0 前后 |
| dev 启动全量编译 `src/**/*.ts` + 全量生成 `zod.js` | Vite 风格按需编译（`compileOnDemand`）：启动只编译 config + 生成路由清单，handler.js / zod.js 首次请求时按需生成 | 项目变大启动慢、watch 重建耗时高 | 6.x |
| `scanRoutes` / `scanTools` 运行时 `import` handler / tool 模块提取方法名 | 零 import：正则 / AST 扫描源码 | 运行时 import 让 dev 启动慢、按需编译无法实现 | 6.x |
| `extractAllTypes` 提前解析文件全部顶层类型 | 按需提取（`collectRouteSchemaSources`） | 任何无关类型坏掉都让提取整体失败 | — |

### 1.1 已移除的迁移护栏（2026-10-28 维护者决策）

曾经为升级用户保留过一批"检测到残留写法即抛错（附迁移指引）"的护栏；维护者随后决策**不做残留检测报错**并追溯移除全部既有护栏——残留写法改为静默无效或语言层 `TypeError`，类型层拒绝是唯一防线：

| 位置 | 触发（旧：抛错附迁移指引） | 现状 |
| --- | --- | --- |
| `agent:root-input` 载荷 `input` | `e.input = …` | getter-only，赋值抛 `TypeError` |
| `agent:input` 载荷 `messages` | `e.messages = […]` | getter-only，赋值抛 `TypeError` |
| agent handler 导出 `run` | 启动期求值阶段抛错 | `run` 导出被忽略（声明式执行） |
| 残留 `@tool` JSDoc 标签 | schema 提取抛 `SchemaExtractionError` | 标签静默忽略，名字仍由目录推导 |
| `task.driver: 'memory'` | 专属迁移错误 | 落入未知驱动通用报错 |
| agent config 声明 `model` | 专属迁移报错（本无） | 撞「未知 config 字段」白名单通用报错（`loadAgents` 的 `KNOWN_CONFIG_FIELDS` 不含 `model`，功能性校验维持，无专属护栏；类型层 `AgentConfig` 的 index signature 允许该键） |

构建期**功能校验**不属于残留检测，维持不变（如 `task.ts` 声明 `timeoutMs` / `graceMs` 的错位报错、`worker.ts` 缺 `timeoutMs` 必填报错、同目录两种任务文件并存的歧义报错、**未知 config 字段白名单报错**——均为现行约定的一致性校验；agent config 的 `KNOWN_CONFIG_FIELDS` 白名单不含 `model`，声明 `model` 会撞通用报错，无专属护栏）。

> 勘误（2026-10-28）：`@faapi/faapi` 7.14.0 CHANGELOG 中「agent config 声明 `model`：文档口径修正——运行时本无检测，声明被忽略」为**错误描述**——运行时存在未知字段白名单通用报错（`loadAgents.test.ts` 有断言），`config.model` 声明会被拒绝。本节表格为准确口径；CHANGELOG 由 changesets 生成不回改，以本台账为准。

### 1.2 有意保留的兼容面（不是残留）

- `TracingToolResult` / `isTracingToolResult`（`@faapi/agent`，`@deprecated`）：旧 `__trace` 标记结构仍被 reactLoop 识别（嵌入 sub-trace、不上卷用量），供存量自定义 `executeTool` 使用；公开导出 + 回归测试。
- `SessionManager` 构造 `(ttl: number)` 旧签名（`@faapi/mcp`）：与 options 对象并存，公开导出。

---

## 2. 踩坑与事故记录

每条给出：发生了什么 → 由此确立的现行规则 / 实现（规则本体在何处）。

| 事故 / 踩坑 | 现行承接 |
| --- | --- |
| **v7.9.0 发布门禁**：本机 macOS APFS 与 CI Ubuntu ext4 的 mtime 粒度不同，两次写入落在同一 mtime 刻度，`isProductFresh` 反向误判；叠加「预期 reject 的用例不 close app」导致单例级联，三用例连挂 | AGENTS.md 6.6 测试确定性四条硬规则（`utimesSync` 显式造差、防御式 close、确定性信号、禁止环境假设）+ 两包 `vitest.setup.ts` 泄漏守卫 |
| **v7.9.0 文档滞后**：删公开 API 后只 grep `*.ts`，`agent.md` / `testServer.md` / `testing.md` / README 的旧示例由业务方发现 | `faapi-framework-dev` 技能：残留检查覆盖全文件类型（`.ts` + `.md`，含根 README 与 AGENTS.md） |
| **CI（Linux）vitest 下按需编译失败**：「import 失败 → 编译 → 重试 import」模式中，`vi.importActual` 首次 import 不存在的文件后 Vite SSR 内部状态被污染，加 cache-busting query 在 CI 上无效 | `loadRouteModule` 先编译再 import（`ensureCompiled` 前置） |
| **`enableTracing` 静默不生效**：deps 装配曾消费 `llms` 与 `config` 双参数，插件侧清单漏拼该字段，`faapi.config` 配置后无任何告警 | `createAgentDeps({ agentConfig })` 单一入参，配方一次声明两路到达（`agentDeps.md`） |
| **隔离任务 JSON 快照**：Date 变字符串、静默丢字段 | `collectConfigSnapshot` 纯数据投影 + 不可克隆值显式报错列路径（`configSnapshot.md`） |
| **多份等价实现并存漏改**：`toProdFilePath` 4 份逐字相同 / `compileDevRoutes` 与 `compileBuildRoutes` 90% 重复 / 三条 zod 产物管线复制粘贴 / 三个 scanner 各自一份目录段白名单——任一处漏改即 dev/prod 产物不一致或三域命名口径分裂 | 单一实现 + 参数差异：`utils/prodPaths` / `cli/compileSourceFiles` / `cli/generateZodArtifacts` / `naming/nameRules` |
| **watcher 只有 debounce、无重入保护**：git 切分支的批量 change+unlink 事件留在集合里，同批新文件永远编译不到直到重启 | `cli/rebuildScheduler` 重入保护 |
| **dev 热重载只删不生成**：每次保存后所有路由的首个请求同步付全项目 Program 创建 + schema 生成代价（p99 尖刺） | reload 后异步预生成（`createDevApp.md`） |
| **CORS Vary 读请求头**：看不到其他中间件设置的响应 Vary，还把客户端伪造的 Vary 请求头带进响应（缓存污染面） | `middlewares/mergeVary` 读 `meta.headers` 权威来源 |
| **query 重复键 last-wins**：静默丢前值，声明 `ids: number[]` 的字段永远校验失败 | `utils/queryToObject` 聚合重复键 |
| **索引签名丢弃全部属性** | `ast/supported-types` 修正 |
| **插件加载失败仅 `Cannot find module`**，无法定位原因 | `cli/loadPlugins` 错误含路径与原因 |
| **sub-agent 派发名 `agent.` 点号**在强校验上游（DeepSeek / OpenAI）整单 400（业务反馈 TODO-faapi-gaps #1） | `agent-` 前缀 + `_` 连接（`injection/subAgentToolName`） |
| **Next 客户端错误不可读**：单页 4 个请求 3 个裸 `SyntaxError`，用户无从下手（TODO-faapi-gaps） | `@faapi/next` `client/apiCall` 统一解析接口错误 |
| **业务项目从 `@faapi/faapi` import 类型踩坑**（llm 项目 `api-types.ts` 注释记录） | `@faapi/next` client 目录所有类型独立声明 |
| **轻量补全失败被静默吞掉**：切章分类超时静默回落纯正则，整书错误切分无人知晓 | `lightComplete` 传输失败恒抛 `LLMProviderError`，无降级出口 |
| **两条等价路径并存**：载荷实体名 vs 专属名订阅；root-input 可写 `input` vs `addInput` + `{{rawInput}}` | 单一路径原则——7.10.0 / 7.12.0+ 两次收敛（见第 1 节） |
| **禁止降级历史处置（原 `fallback.md` 九条，全部了结）**：任务 payload 无声明跳过校验 / 隔离任务错误 props 不可克隆丢 props / 日志 fields 不可序列化降级提示文本 / 隔离任务日志 fields 不可克隆丢 fields / 隔离任务 `taskCtx.llm` 插件不可解析 warn+undefined / 中间件加载失败空 bundle / 插件失败汇总后继续启动 / 任务 meta 非字面量警告后忽略——以上八条均改为显式失败；隔离任务 config JSON 快照改为不传 config（后以纯数据投影承接） | AGENTS.md 5.6.4 三种显式出口（抛错 / 声明能力边界 / 留痕不改主流程） |

---

## 3. 存疑 / 待决

> 已了结（2026-10-28 维护者决策）：**不为已移除概念的残留痕迹做检测报错**——残留 JSDoc 标签（如 `@agent`）、残留配置键等旧写法痕迹保持静默无效 / 归入业务自定义配置即终态，类型层拒绝是唯一防线；不再新增任何"检测到残留即抛错"式守卫。该决策**追溯适用于既有护栏**——1.1 节所列迁移报错已全部移除（含 `@tool` 标签、`run` 导出、memory 驱动特判、root-input/input 载荷 setter 抛错；`config.model` 运行时本无检测，文档口径一并修正）。

| 事项 | 现状 | 待决点 |
| --- | --- | --- |
| ~~`@agent` 覆盖名残留标签~~ | **已了结**：残留标签静默无效即终态（维护者决策，不做残留检测报错） | — |
| ~~已移除配置键的运行时拒绝~~ | **已了结**：不做运行时报错——已移除键归入 `ctx.config` 业务自定义配置为既定行为，类型层拒绝是唯一防线（维护者决策，同上口径） | — |
| 兼容面保留期限 | `TracingToolResult` / `SessionManager(number)` 无弃用时间表 | 何时移除、是否随下一个 major |
| `startServer.ts` 文件名 | 内容已是 listen 工具函数，名字为历史路径 | 是否改名（涉及 import 路径与文档） |
| `scanRoutes` 的源码 `.ts` import 路径 | 「兼容无 dist 的旧调用方（testServer / 单测）」需要 tsx | 是否收敛到统一产物路径 |
