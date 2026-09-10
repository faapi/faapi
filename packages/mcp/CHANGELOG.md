# @faapi/mcp

## 5.3.0

## 5.2.0

## 5.1.0

## 5.0.1

### Patch Changes

- 版本线修复：此前 5.0.0 被误发布到 npm（其中 `@faapi/faapi` 与 `@faapi/mcp` 因依赖关系无法 unpublish，该版本号已作废不可复用），版本线跳过 5.0.0 对齐到 5.0.1。本版本功能内容与 4.5.0 完全一致（含移除 `config.agent` 的 `defaultAgent` / `defaultLlm` 配置——`agent.run/stream` 改为每次调用显式传 `options.agent` 与 `options.model` / `options.provider`）。

## 4.5.0

## 4.4.0

## 4.3.0

## 4.2.1

## 4.2.0

## 4.1.0

## 4.0.0

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

- 5d95fdd: MCP Streamable HTTP 的 JSON-RPC 批量处理对齐规范并并行化：

  - **批内单条无效不再整批 400**：JSON-RPC 2.0 规范要求仅对无效条目生成 `id:null` 的 ParseError 响应，其余条目正常处理。新增 `parseJsonRpcBatch`，解析失败的条目以错误响应形态并入批响应数组；空批保持 400 Invalid Request
  - **批内请求并行执行**：此前串行 `await`（一个慢 tool 阻塞同批后续请求），现为 `Promise.all` 并行，响应按请求声明顺序回传（与完成顺序无关）；单个请求的错误由 handleJsonRpc 内部转为 error response，互不影响

- 9d5865d: - **@faapi/mcp**：过期 session 不再参与广播与查询——`broadcastToSession` 对目标会话做过期检查（过期即清扫并关闭订阅者，不投递），`allSessionIds` / `findSubscribersOfUri` 遍历前清扫过期会话。长时间无新 `initialize` 的服务此前会累积幽灵 session（常驻内存、持续接收广播的空转 enqueue），现在广播/查询路径惰性清除
  - **@faapi/faapi**：内部重构——`extractToolMetadata` / `extractAgentMetadata` 的 JSDoc 工具函数（`hasExportModifier` / `getJSDocFromNode` / `extractDescription` / `@tag` 覆盖名提取）统一到 `jsDocMetadata` 模块，消除逐字重复
- 06b1f05: 修复 resource 批量重建的 N+1 广播风暴：

  - `mcpServer` 的 `removeResource` / `removeResourceTemplate` 新增 `{ silent: true }` 选项——跳过 `notifications/resources/list_changed` 逐次广播
  - `@faapi/schema` 的 schemaServer 资源重建（先清 N 个旧 resource 再注册）改为静默删除、末尾统一广播一次——路由多的项目此前每次 dev reload 会向所有 SSE session 发送 N+1 次相同通知

## 3.3.0

## 3.2.1

## 3.2.0

## 3.1.0

## 3.0.0

### Patch Changes

- Updated dependencies [1d54523]
- Updated dependencies [1d54523]
- Updated dependencies [49d7ac9]
  - @faapi/faapi@3.0.0

## 2.0.1

## 2.0.0

### Patch Changes

- Updated dependencies [1258e39]
  - @faapi/faapi@2.0.0

## 1.5.0

## 1.4.0

## 1.3.1

## 1.3.0

## 1.2.1

## 1.2.0

## 1.1.1

### Patch Changes

- 改进发布流程：通过 tag 区分 canary 和 stable 发布

## 1.1.0

### Patch Changes

- Updated dependencies [853a175]
  - @faapi/faapi@1.1.0

## 1.0.2

### Patch Changes

- Updated dependencies
  - @faapi/faapi@1.0.2

## 1.0.1

### Patch Changes

- Updated dependencies
  - @faapi/faapi@1.0.1

## 1.0.0

### Major Changes

- 首次发布 @faapi/mcp——纯手写 MCP Server SDK，不依赖 @modelcontextprotocol/sdk。提供 Streamable HTTP transport（POST JSON-RPC / GET 405 / DELETE 销毁会话）、zod-native tool 定义（通过 zod v4 内置 toJSONSchema 转 JSON Schema）、MCP 协议核心方法（initialize / tools/list / tools/call / ping / notifications/initialized）、Session 管理（Mcp-Session-Id header，内存 Map + TTL 过期机制，默认 30 分钟惰性清理）、faapi 适配器（createMcpHandler / createMcpNodeHandler）。capabilities 声明 `listChanged: false`（v1 无 SSE 推送）。

### Minor Changes

- 将 `zod` 从 `dependencies` 改为 `peerDependencies`（运行时直接 import zod）。业务方需在项目 `package.json` 显式安装 `zod@^4`。
