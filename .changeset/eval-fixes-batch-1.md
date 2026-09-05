---
'@faapi/faapi': patch
'@faapi/mcp': patch
'@faapi/agent': patch
---

框架评估修复批次 1：三个 P0 功能缺陷 + 热路径性能 + 安全边界。

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
