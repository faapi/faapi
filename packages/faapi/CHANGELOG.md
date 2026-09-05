# @faapi/faapi

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

- d822718: 框架评估修复批次 3：响应压缩、ETag/304 协商与 dev schema 后台预生成。

  - **响应压缩（`config.compression`，默认关闭）**：按 `Accept-Encoding` 协商 br > gzip > deflate（含 q 值与 `*` 通配），压缩 JSON/文本响应；SSE/流式、已压缩、`no-transform`、低于 threshold（默认 1024 字节）的响应自动跳过；无条件补 `Vary: Accept-Encoding`（与 CORS 的 `Vary: Origin` 合并存放）。JSON API 响应体积通常缩小 5-10 倍
  - **ETag/304 条件请求协商（`config.etag`，默认关闭）**：GET/HEAD 2xx 响应自动生成弱 ETag（SHA-1），`If-None-Match` 弱比较命中返回 304。弱校验器与压缩正确配合（ETag 基于未压缩表示，304 无 body 时压缩自动跳过）；handler 显式 `ctx.setETag()` 时不覆盖。此前框架只有 `setETag` 写头，既不生成也不协商，条件请求能力缺位
  - **dev schema 后台预生成**：watcher 热替换后按需模式此前只删 zod.js 不重建，每次保存后所有路由的首个请求都要在请求路径上同步付全项目 Program 创建 + schema 生成的代价（p99 尖刺）。现在 reload 后台批量预生成（不阻塞 reload 与请求），请求路径的按需生成（mtime 缓存 + in-flight mutex + 原子写）兜底协同

### Patch Changes

- eadf440: agent 子系统 LLM 调用层新增超时、重试与取消支持（生产长任务稳定性）：

  - **取消（AbortSignal）**：`agent.run/stream` 的 options 新增 `signal`，沿 agentHandle → Agent → reactLoop → provider 透传到底层 HTTP 请求。循环每轮开始前预检查，执行中取消请求中断并抛 `AgentAbortError`（新导出）——业务方通过 `instanceof` 区分用户取消与真实错误（SSE/WS 客户端断开后不再白烧 token）
  - **超时**：`LlmConfig.timeoutMs`（毫秒，可选，未设置时无超时），provider 层用 `AbortSignal.timeout` 实现，与 run-level `signal` 组合生效；超时触发抛 `LLMProviderError`（message 含 timed out）
  - **重试**：429 / 5xx / 网络错误自动重试，`LlmConfig.maxRetries`（默认 2，设 0 关闭）。退避优先尊重响应 `Retry-After` 头（封顶 30s），否则指数退避 500ms × 2^attempt；4xx 其他状态（400/401 等）确定性错误不重试；流式仅在连接建立前重试，每次重试刷新超时预算
  - **流取消**：stream 提前终止（消费者 break）时主动 `reader.cancel()` 释放底层 HTTP 连接，不再等待 body 缓冲耗尽

- 类型校验四项边界修复：

  - **命名空间类型（`NS.Type`）可解析**：QualifiedName 引用此前直接抛"无法解析的引用类型"，现在经 checker 定位到 namespace 内真实声明
  - **索引签名与属性共存不再丢属性**：`{ a: string; [k: string]: unknown }` 此前索引签名直接吞掉全部具名属性（含继承的），现在属性保留、索引签名生成 `z.object({...}).catchall(...)`——开放对象与封闭字段可同时校验
  - **交叉类型含非 object 成员显式抛错**：branded 类型（`string & { __brand: 'X' }`）此前静默丢弃非 object 成员导致校验被放宽，现在按"不降级放行"约定抛 SchemaExtractionError
  - **元组可选前缀 + rest 保留可选性**：`[string?, ...number[]]` 此前 rest 分支丢弃 fixedOptional，空数组（TS 合法）被误拒；zod v4 原生支持 `z.tuple([X.optional()]).rest(...)`，生成端直接应用

- 981c99f: AST 提取链路惰性化重构（健壮性 + 性能）

  - **无关类型不再拖垮 build**：schema 提取改为惰性解析——只解析路由入口类型及其引用可达的类型，文件中未被任何入口引用的类型（哪怕含不支持语法）不再触发 `SchemaExtractionError` 拖垮整个 build/reload。此前 `extractAllTypes` 提前解析文件全部顶层类型，一个无关的坏类型就会让提取整体失败
  - **消除重复解析**：`analyzeInjection` 新增 `analyzeInjectionInSourceFile` 变体，复用 program 已解析的 SourceFile——此前同一文件 N 个方法会重复 `createSourceFile` 全量 parse N 次；入口类型经 `createLazyTypeResolver` 缓存解析，消除 `extractAllTypes` + `extractTypeInfo` 对同一类型的重复提取
  - **API 调整**：`collectRouteSchemaSources` 返回值中 `allTypesByFile` / `mergedAllTypes` 替换为 `resolversByFile`（按文件的惰性类型解析器，`resolve(name)` 缓存幂等）；`generateSchemaFileSource` / `generateToolSchemaFileSource` 的 `allTypes` Map 参数改为 `resolveType` 函数。`extractAllTypes` 保留为独立 AST 能力不变
  - tool schema 收集（`collectToolSchemaSources`）同步惰性化，收益与路由 schema 一致

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

- f60d137: 框架评估修复批次 2：HTTP 语义补齐、优雅停机、性能与产物一致性。

  - **HEAD 回退 GET**：无显式 HEAD 路由时复用 GET handler（Node 自动丢弃 body）。探活、CDN 健康检查、HTTP 客户端预检常用 HEAD——此前只定义 GET 的路由对 HEAD 返回 405，监控大面积误报。`findAllowedMethods` 在 GET 允许时把 HEAD 加入 Allow 头（RFC 9110）
  - **默认优雅停机**：`listen()` 现在默认注册 SIGTERM/SIGINT 处理（进程级仅一次），收到信号走 `app.close()`（drain 在途请求 + `onClose` 钩子 + 注册表清理）后退出——此前仅在配置了 `onClose` 时注册。`close()` 从"立即 `closeAllConnections` 硬关"改为 drain 语义：断开空闲 keep-alive → 等在途请求完成 → SSE/WS 长连接超时（`FAAPI_SHUTDOWN_TIMEOUT_MS`，默认 10s）后强制断开。滚动部署不再硬断连接
  - **query 重复 key 聚合为数组**：`?tag=a&tag=b` 现在得 `{ tag: ['a', 'b'] }`（对齐 Express qs / Hono getAll）——此前 last-wins 静默丢弃，声明 `string[]` 的 query 字段永远校验失败（解析端从未产出数组）。单值字段行为不变
  - **dev 按需 Program 缓存按 tsconfig 共享**：共享缓存 key 此前含文件列表，每个路由文件各自持有一份全项目 TS Program（内存 O(路由数 × 项目大小)，无淘汰）；现在同一 tsconfig 只建一份 Program，通过 `getSourceFile` 校验覆盖全部入口
  - **产物原子写**：zod.js、faapi-routes.js、faapi-tools.js、faapi-agents.js、faapi-helpers.js 统一改为 tmp+rename 原子写（新增 `utils/atomicWrite`）——dev watch 重建与在途请求并发时，请求不会再 import 到截断的半成品产物
  - **`formatErrorResponse` 不再就地改写业务方 `response.fail` 返回对象**：issues 附加改为浅拷贝扩展，业务方复用/冻结 fail 返回对象不再引发跨请求污染或静默失败
  - **rebuildScheduler 待编译文件去重**：编辑器连续保存触发的多次 change 事件不再导致同一文件在同一轮重复编译
  - **readTsconfig 按 mtime 缓存**：watcher 每轮重建、每次首请求按需编译都会读 tsconfig，Compiler API 解析（含 extends 链合并）结果按 mtime 缓存，tsconfig 变化自动失效

- c18c62e: 框架评估修复批次 4：注册表清理所有权、MCP 定时器泄漏、观测数据修正与会话上限。

  **@faapi/faapi**

  - **注册表清理所有权守卫**：`app.close()` 此前无条件清空全局 tool/agent/skill 注册表与 agent handle 工厂——同进程多 app 场景（测试/嵌入）下，先创建的 app close 会清掉运行中 app 的注册表。现在仅在自身是当前单例 app 时清理，与单例清理的所有权检查语义对称

  **@faapi/mcp**

  - **Node 适配器 SSE 断连泄漏修复**：客户端断开后源流不销毁，底层 web ReadableStream 的 `cancel()` 永不触发——SSE 心跳 `setInterval` 持续 enqueue 到无消费者的流（定时器 + 队列持续泄漏）。现在断连时销毁源流并按正常完成收尾（与主包 sendNodeResponse 语义一致）
  - **SessionManager 会话数上限**：新增 `sessionMaxSessions` 选项（默认 1000，0 不限），`create` 时超限按 LRU（最久未活动）淘汰并关闭订阅者——防 initialize 洪水在 TTL 窗口内无限堆内存

  **@faapi/agent**

  - **并行 tool tracing durationMs 失真修复**：结束时间此前在 `Promise.all` 之后的串行循环里统一采集，同轮每个 tool 的 `durationMs` 都包含等待其他 tool 的时间（全部失真为「最慢 tool」耗时）。现在在各自执行闭包内采集，`durationMs` 只反映自身执行耗时

- 13c6297: 框架评估修复批次 5：AST 静默弱化、插件加载口径、build 清目录与 CLI DX。

  - **AST 三类静默弱化消除（不再违背「不降级放行」约定）**：
    - 接口/对象类型含方法签名或存取器此前被静默丢弃（校验弱于 TS 类型且无告警），现在显式抛 `SchemaExtractionError`
    - `Required<T>` 此前原样返回内部类型（可选字段在 schema 中仍是 optional），现在与 `Partial` 对称恢复必填；`Readonly<T>` 明确为编译期约束等同去掉修饰符
    - 交叉类型同名字段此前直接 push 合并（重复字段后者静默胜出，校验比 TS 宽松），现在按名去重（类型一致时保留带约束的声明），类型/可选性冲突（TS 语义为 never）显式抛错
  - **loadPlugins 错误口径统一**：插件失败此前仅单条 `console.warn` 易被淹没（prod 下鉴权类插件静默丢失等同裸奔），现在收集进返回值 `failures` 并在加载完成后 `console.error` 汇总；非法声明不再崩启动；`path` 声明相对项目根目录解析为 file URL（此前相对 faapi 包产物解析，几乎必然失败）
  - **build 清空输出目录（emptyOutDir 语义）**：删除/重命名路由后 `dist/` 不再残留死产物；防误删保护——outdir 不在 rootDir 内时跳过清空并告警
  - **build 移除重复 `compileConfig` 调用**：mtime 缓存引入后第二次调用只命中缓存却打印 "Written to" 谎报日志
  - **CLI**：`faapi --version` 输出版本号；命令失败输出一行友好摘要（`FAAPI_DEBUG=1` 附完整堆栈），不再裸堆栈糊屏
  - **watcher**：重建失败逐条输出 esbuild 结构化错误（file:line + text），不再压扁成一句摘要；监听 `tsconfig.json` 变化（别名重写与 mtime 缓存输入）；增量编译跳过 `*.test.ts` / `*.e2e.test.ts` / `*.d.ts`（测试文件语法错误不再打断 dev 重建）
  - **CORS**：动态 origin（true/数组）下 Origin 不匹配的拒绝响应同样补 `Vary: Origin`——缺了它 CDN 按 URL 缓存拒绝响应后可能服务给合法 Origin（缓存污染面）

- 6f2903f: 框架评估修复批次 6：低影响性能微优化与诊断增强。

  - **响应头零重建**：仅 headers 型 meta（helmet 开启后每请求 ~13 个静态头）此前导致 `ctx.ok()` / `ctx.fail()` / 中间件返回的 Response 每请求经历 `new Headers()` 拷贝 + `new Response()` 重建；现在延迟到 Node 发送层一次性 `setHeader`（`pendingMeta` 通道，WeakMap 弱键），compression / etag 重建路径自动搬运
  - **动态路由 pattern 预编译**：模式段 split 此前每请求对每条动态路由重复执行，现在索引构建期一次性预编译（`DynamicEntry.segments`）
  - **路由派生路径缓存**：每请求的 `path.resolve`（handler 绝对路径）与 `getRuntimeSchemaPath` 字符串运算按 route 对象 WeakMap 缓存（清单替换自动失效）
  - **空白 body 判空**：`text.trim() === ''` 的全量字符串拷贝改为 length 短路 + 正则扫描
  - **目录中间件首载 in-flight 去重**：冷启动并发首请求对同一 middlewares.ts 不再重复 import + 合并（对照 compileOnDemand 的 mutex 模式）
  - **SchemaExtractionError 带 file:line:column**：不支持语法 / 方法签名 / 交叉冲突等抛错点经 `SchemaExtractionError.at(node)` 携带精确源码位置，几百行类型文件不再靠肉眼定位
  - **coerceBoolean 大小写不敏感**：`"True"` / `"TRUE"` 现可正确转换（对齐 HTML 表单习惯）
  - **build 检查 CJS 项目**：package.json 缺 `"type": "module"` 时构建告警（产物为 ESM，`node dist/main` 否则报难以关联的语法错误）

- b31a442: 修复两处参数校验正确性问题：

  - **数字/布尔字面量的 query 校验不再必然失败**：query/params 声明 `status: 1 | 2` 这类字面量（联合）时，URL 传来的是字符串 `"1"`，此前裸 `z.literal(1)` 必然校验失败。现在 coerce 模式下数字/布尔字面量（含 union 成员级）自动包 `z.preprocess` 做字符串转换；混合联合（`'active' | 1`）中仅数字/布尔成员包裹，string 字面量天然命中
  - **数组 body 不再被静默替换为 `{}`**：`type POSTBody = string[]` 生成的 schema 是 `z.array`，但运行时校验前数组输入被替换为 `{}`，导致合法数组 body 永远校验失败且 issue 误导为 `received object`；无 schema 时数组 body 也会被静默吞掉。现在校验输入与校验结果均原样透传，数组/顶层原始值 body（如 `type POSTBody = string`）正常工作

- 3c12dc6: 修复三处正确性问题：

  - **@faapi/faapi**：`interface extends` 继承不再抛 SchemaExtractionError（heritage 节点此前未接入解析链，与文档承诺不符）；同时新增泛型类型支持——泛型 interface / type 别名按位置绑定类型实参（`Box<string>`）、支持默认类型形参（`<T = string>`）、泛型形参遮蔽同名真实类型，实参缺失且无默认时显式抛错
  - **@faapi/mcp**：GET SSE 心跳 tick 续期 session（`SessionManager.touch`），只收推送不发请求的客户端不再因空闲 TTL 被 30 分钟强制断开；携带无效/已过期 `Mcp-Session-Id` 的 GET 请求改为返回 404（MCP 规范），客户端可据此重新 initialize 而非静默空转
  - **@faapi/agent**：OpenAI provider 的 SSE 解析兼容 CRLF / CR 行尾（SSE 规范允许），使用 CRLF 行尾的 OpenAI 兼容网关此前流式输出完全失效（事件无法切分、`[DONE]` 识别失败）

- 4617c07: watcher 加固：修复重建调度与编译效率问题

  - **重入竞态修复**：重建链（增量编译 + config 重生成 + reload 三件套）很容易超过 debounce 的 100ms 窗口，此前重建进行中的文件事件会并发触发第二个重建，导致并发写产物、状态交错不一致。新增 `createRebuildScheduler` 调度器：重建进行中不重入，新事件只累积文件，当前轮结束后自动串行补跑
  - **编译失败不再丢文件**：此前待编译集合在编译前被清空，编译失败（如语法错误）后这批文件被丢弃，同批次无关文件必须等下次修改才能重编译。现在失败批次回灌待编译集合，等待下次文件事件一起重编译（不主动定时重试，避免错误刷屏）
  - **config 重编译短路**：`compileConfig` 内置 mtime 短路缓存——watcher 每次重建（改任意 src 文件）此前都无条件执行 3 次 esbuild build + 依赖图递归读盘；现在 config 源及其依赖无变化时直接跳过。`faapi build` 步骤 0/2 的重复编译也由此自然短路

- 9d5865d: - **@faapi/mcp**：过期 session 不再参与广播与查询——`broadcastToSession` 对目标会话做过期检查（过期即清扫并关闭订阅者，不投递），`allSessionIds` / `findSubscribersOfUri` 遍历前清扫过期会话。长时间无新 `initialize` 的服务此前会累积幽灵 session（常驻内存、持续接收广播的空转 enqueue），现在广播/查询路径惰性清除
  - **@faapi/faapi**：内部重构——`extractToolMetadata` / `extractAgentMetadata` 的 JSDoc 工具函数（`hasExportModifier` / `getJSDocFromNode` / `extractDescription` / `@tag` 覆盖名提取）统一到 `jsDocMetadata` 模块，消除逐字重复

## 3.3.0

### Minor Changes

- d9a2830: `@faapi/agent` 性能优化：tool schema 解析新增跨请求缓存。此前 Agent 工厂每请求构造新实例，每个请求都重新执行 `loadToolSchema`（dynamic import）+ `z.toJSONSchema`（CPU 密集）；现在 setup 闭包级缓存解析结果，按 zod.js 路径 + inputTypeName 作键、文件 mtime 自校验失效（dev `reloadTools` 重生成后自愈，prod 永远命中），并发请求共享同一次解析。高 QPS agent 端点每请求省去 schema 重复解析开销。

  `@faapi/faapi` 新增 `getToolSchemaPath(tool, rootDir?)` 公开导出（计算 tool 的 zod.js 绝对路径，纯路径计算），与 `loadToolSchema` 共享 dist 解析逻辑。

- 924f0a1: 构建性能优化：schema/tool/agent 产物生成改为批量共享 TypeScript Program（新增 `createPrograms` 公开导出）。此前每个 handler 文件单独创建一个含全项目源码的 Program，N 个文件重复解析 N 遍；现在同一次生成中查找到同一 `tsconfig.json` 的文件共用一个 Program，`faapi build` 与 dev 首次请求生成 zod.js 的 AST 阶段开销从 O(N×全项目) 降为 O(全项目)，大项目下提升数量级。跨文件 `import type` 解析语义不变。
- 8678807: 新增 `trustedProxy` 配置（默认 `false`），`ctx.ip` 默认不再信任 `X-Forwarded-For`。

  此前 `getClientIp` 无条件取 XFF 第一个 IP——客户端直连时该 header 可被任意伪造，污染 `ctx.ip`（影响限流/日志/访问控制）。现在的行为：

  - `trustedProxy: false`（默认）：直取 socket 地址，XFF 被忽略——直连部署防伪造
  - `trustedProxy: true`：沿用原行为，取 XFF 第一个 IP——部署在 nginx/CDN 等受信任反向代理之后时在 `faapi.config.ts` 显式开启

  **升级注意**：部署在反向代理之后、依赖 `ctx.ip` 为客户端真实 IP 的项目需显式配置 `trustedProxy: true`，否则 `ctx.ip` 会变为代理的 socket 地址。同时影响 HTTP 与 WebSocket 握手。

### Patch Changes

- dbcdb5c: 请求热路径优化批次（行为语义不变）：

  - **URL 单次解析**：每请求只在 `toWebRequest` 内做一次 `new URL`，pathname/searchParams 由 ctx 与参数解析共享（原一次请求重复解析 3~4 次）；新增内部变体 `createContextFromUrl` / `resolveInputFromUrl`，公开 API 签名不变。
  - **content-length 快速 413**：请求体带 `content-length` 且超过 `bodyLimit` 时在流读取前直接返回 413（chunked 无此头仍走流式限流）。
  - **外层中间件链启动期组装**：CORS → helmet → logger → 全局中间件数组在 createServer 时构建一次，每请求不再重复 spread 重组。
  - **dev 热路径同步 IO 短路**：`prodPathToSourcePath` 映射缓存（reloadRoutes 时清空），`loadRouteModule` 去掉冗余的每请求 `existsSync`——编译完成后稳态请求零 fs 访问。

- 7140e6e: 路由匹配索引化：每请求的 O(n) 线性扫描改为静态路由 O(1) Map 命中 + 动态路由按序扫描（索引按清单数组身份 WeakMap 缓存，`reloadRoutes` 整体替换清单后自动失效，匹配语义与原实现完全等价）。`findAllowedMethods`（405 反查）同步索引化，扫描器/探活探测的高频 404 场景开销显著下降。

## 3.2.1

### Patch Changes

- cfe6c4c: 修复跨文件 `import type` 解析失败:业务项目用 `moduleResolution: Bundler` + 无扩展名相对导入时,`faapi build` / tool schema 提取抛 `SchemaExtractionError`

  ## 根因

  `createProgram` 硬编码 `moduleResolution: NodeNext`,而业务项目用 `Bundler`。NodeNext 的 ESM 解析要求相对导入带文件扩展名,无扩展名的 `import type { X } from '../../db/schema'` 绑定不到声明,checker 拿不到跨文件 symbol,`resolveTypeReference` 兜底抛"无法解析的引用类型"。

  ## 修复
  - **`createProgram` 读项目 tsconfig**:用 `ts.parseJsonConfigFileContent` 解析业务项目 `tsconfig.json`,取 `module` / `moduleResolution` 覆盖默认 NodeNext,同时取 `parsed.fileNames` 作为 program 的 rootNames(让跨文件 import 的源文件被加载进 program)
  - **`resolveImportAlias` 增加 program 兜底遍历**:`checker.getAliasedSymbol` 失败时(如 `noEmit` 模式下 alias 未完全绑定),遍历 program 所有非 lib sourceFile 的顶层声明找同名 `InterfaceDeclaration` / `TypeAliasDeclaration` / `EnumDeclaration`
  - **模块级 program 上下文**:因 `TypeChecker` 运行时未暴露 `getProgram()`,新增 `setProgramContext(program)` 由 `extractTypeInfo` / `extractAllTypes` 在分析前后设置/清空

  ## 业务方影响
  - tool / route handler 的 input interface 可正常引用跨文件类型(如 db schema),无需内联重复声明
  - 与 faapi skill 文档"moduleResolution: Bundler,本地相对导入不写后缀"约定一致
  - 无 API 变更,向后兼容

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
