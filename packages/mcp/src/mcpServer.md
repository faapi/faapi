# mcpServer

一句话概括：MCP Server 核心——tool/resource/prompt 注册 + JSON-RPC 方法分发（initialize/tools/resources/prompts/logging/ping）

## 为什么需要

这是 @faapi/mcp 的核心模块，实现 MCP 协议的服务端逻辑。不依赖 @modelcontextprotocol/sdk，纯手写 MCP 协议。

## 使用场景

用户通过 `createMcpServer()` 创建实例，按需注册 tools/resources/prompts，然后在 faapi handler 中通过 `createMcpHandler(mcp)` 暴露为 HTTP 端点。

## 核心方法

- `tool(name, definition)` — 注册 tool（zod raw shape 作为输入参数）
- `resource(uri, definition)` — 注册资源（业务方提供 read handler）
- `resourceTemplate(uriTemplate, definition)` — 注册资源模板(RFC 6570 URI 模板,业务方提供 read handler 接收提取的 params)
- `prompt(name, definition)` — 注册提示模板（业务方提供 get handler）
- `completion(ref, argumentName, handler)` — 注册参数补全 handler(为 prompt/resource template 的参数提供自动补全候选值)
- `method(name, handler)` — 注册自定义 JSON-RPC 方法 handler(业务拓展,非 MCP 标准方法)
- `handleJsonRpc(message, session)` — 分发 JSON-RPC 消息，返回响应或 null（通知）
- `getSessionManager()` — 获取会话管理器
- `listTools()` / `listResources()` / `listPrompts()` / `listMethods()` — 列出已注册项名称
- `removeTool(name)` / `removeResource(uri)` / `removeResourceTemplate(uriTemplate)` / `removePrompt(name)` / `removeCompletion(ref, argumentName)` / `removeMethod(name)` — 删除注册项
- `notifyToolsListChanged()` / `notifyResourcesListChanged()` / `notifyPromptsListChanged()` — 推送 list_changed 通知
- `sendLogging(sessionId, level, data, logger?)` — 向 session 推送 `notifications/message` 日志(SSE 流)
- `sendResourceUpdated(uri)` — 向所有订阅了该 URI 的 session 推送 `notifications/resources/updated`
- `sendProgress(sessionId, progressToken, progress, total?)` — 向 session 推送 `notifications/progress` 进度通知
- `sendNotification(sessionId, method, params)` — 通用通知推送(业务拓展,任意 method/params)

## McpServerOptions

| 选项 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `name` | `string` | 必填 | 服务端名称(initialize 返回) |
| `version` | `string` | 必填 | 服务端版本(initialize 返回) |
| `toolsListChanged` | `boolean` | `false` | tools 列表可变,removeTool 时推送通知 |
| `resourcesListChanged` | `boolean` | `false` | resources 列表可变,removeResource 时推送通知 |
| `promptsListChanged` | `boolean` | `false` | prompts 列表可变,removePrompt 时推送通知 |
| `defaultPageSize` | `number` | `100` | `*/list` 分页默认每页条数 |
| `sessionTtl` | `number` | `30 * 60 * 1000` | session 过期时间(ms),设为 `0` 永不过期;详见 [session.md](./session.md) |
| `sseHeartbeatMs` | `number` | `30 * 1000` | GET SSE 流心跳间隔(ms),详见 [streamableHttp.md](./streamableHttp.md) |

## listChanged 语义（tools/resources/prompts 一致）

`capabilities.{tools,resources,prompts}.listChanged` 控制**列表运行时可变性**:

- `false`(默认):列表不可变,客户端可永久缓存 `*/list` 结果。本类仍提供 `removeTool` 等删除 API,但**不会**主动通知客户端——仅在 dev 热替换、配置 reload 等场景使用
- `true`:列表可变,服务端在 remove 时主动推送 `notifications/{tools,resources,prompts}/list_changed`,客户端收到后重新拉取列表

通过 `McpServerOptions.toolsListChanged` / `resourcesListChanged` / `promptsListChanged` 配置(默认均 `false`)。

```ts
const mcp = createMcpServer({
  name: 'dynamic-server',
  version: '1.0.0',
  toolsListChanged: true,       // 声明 tools 列表可变 + removeTool 时推送通知
  resourcesListChanged: true,
});

// 运行时增删
mcp.tool('temp', { handler: async () => ({ content: [] }) });
mcp.removeTool('temp');  // 自动推送 notifications/tools/list_changed
```

业务方可主动调用 `notifyToolsListChanged()` 等方法手动推送 list_changed 通知(如批量删除后只推送一次)。

## 业务拓展能力

### 自定义 JSON-RPC 方法

业务方可通过 `mcp.method(name, handler)` 注册非标准 MCP 方法,客户端可调用任意 `method` 字段:

```ts
import type { RequestExtra } from '@faapi/mcp';

mcp.method('myapp/health', async (params, session, extra) => {
  extra.sendLogging('debug', { msg: 'health check' });
  return { status: 'ok', uptime: process.uptime() };
});

// 客户端调用
// { "method": "myapp/health", "params": {} }
// → { "result": { "status": "ok", "uptime": 12345.6 } }
```

- `name`:方法名(建议使用 `appName/action` 格式避免与 MCP 标准方法冲突)
- `handler`:`(params, session, extra) => result | JsonRpcErrorResponse`
  - `params`:请求 params(已解析为 unknown,handler 内自行校验)
  - `session`:`McpSession | undefined`(直接调用时可能为 undefined)
  - `extra`:含 `sessionId` / `sendLogging` / `sendProgress`
  - 返回值作为 `result` 字段(直接返回对象)或返回 `JsonRpcErrorResponse` 表示错误
- 重复注册同名方法抛错
- 与 MCP 标准方法冲突时抛错(initialize/ping/tools/* 等)

### 通用通知推送

业务方可通过 `sendNotification(sessionId, method, params)` 推送任意自定义通知到 session 的 SSE 订阅者:

```ts
// 推送自定义通知
mcp.sendNotification(session.id, 'notifications/myapp/sync', { event: 'data-updated' });
```

- 无 session 或无订阅者:静默丢弃
- 不校验 method 是否符合 MCP 规范——业务方自行负责
- SSE 行格式与内置通知一致:`data: ${JSON.stringify(notification)}\n\n`

### 删除注册项

```ts
mcp.removeTool('temp');                    // 删除 tool(若 toolsListChanged: true,自动推送通知)
mcp.removeResource('file://temp');          // 删除 resource
mcp.removeResourceTemplate('file://docs/{path}');  // 删除 resource template
mcp.removePrompt('temp');                   // 删除 prompt
mcp.removeCompletion({ type: 'ref/prompt', name: 'greet' }, 'userName');  // 删除 completion
```

返回 `boolean` 表示是否删除成功(不存在时返回 false)。批量删除后可手动调用 `notifyToolsListChanged()` 等方法只推送一次通知,避免频繁打扰客户端。

## capability 自动协商

initialize 响应中的 capabilities **根据实际注册情况动态生成**:

| 注册情况 | capabilities |
|---------|-------------|
| 仅注册 tools | `{ tools: { listChanged: <toolsListChanged> } }` |
| 仅注册 resources | `{ resources: { listChanged: <resourcesListChanged>, subscribe: true } }` |
| 仅注册 prompts | `{ prompts: { listChanged: <promptsListChanged> } }` |
| 全部注册 | 三者都声明 |

未注册的类别**不声明 capability**,客户端因此知道服务端不支持该能力。tools 永远声明(即使无 tool 也声明 listChanged,保持向后兼容)。

`logging` capability 始终声明(`{ logging: {} }`)——服务端内置日志推送能力,业务方通过 handler extra 的 `sendLogging` 主动推送日志到客户端 SSE 流。

`listChanged` 字段值取自 `McpServerOptions.{toolsListChanged,resourcesListChanged,promptsListChanged}`,默认 `false`。设为 `true` 时客户端应监听 `notifications/{tools,resources,prompts}/list_changed` 并重新拉取列表。

## resource 注册 API

```ts
mcp.resource('file://docs/readme', {
  name: 'readme',                 // 资源名称(必填)
  description: 'Project README',  // 可选描述
  mimeType: 'text/markdown',      // 可选 MIME 类型
  read: async (uri) => ({         // 读取 handler(必填)
    contents: [{
      uri,
      mimeType: 'text/markdown',
      text: '# README content',
    }],
  }),
});
```

read handler 返回 `{ contents: ResourceContent[] }`,每个 content 包含 `uri`/`mimeType`/`text`(或 `blob` 二选一)。

## prompt 注册 API

```ts
mcp.prompt('greet', {
  description: 'Greeting prompt',  // 可选描述
  arguments: [{                    // 可选参数定义
    name: 'userName',
    description: 'User name to greet',
    required: true,
  }],
  get: async (args) => ({          // 获取 handler(必填)
    messages: [{
      role: 'user',
      content: { type: 'text', text: `Hello, ${args.userName}!` },
    }],
  }),
});
```

get handler 接收 `Record<string, string>` 参数(来自客户端 prompts/get 请求的 arguments),返回 `{ messages: PromptMessage[] }`。每个 message 包含 `role`('user'/'assistant')和 `content`(`{ type: 'text', text }` 或 `{ type: 'image', data, mimeType }`)。

## MCP 方法实现

| 方法 | 行为 |
|------|------|
| `initialize` | 协议版本协商,创建/填充 session,返回 capabilities(动态生成)+ serverInfo |
| `notifications/initialized` | 标记 session 为已初始化,返回 null |
| `notifications/cancelled` | 请求取消通知(本实现不处理取消,仅接收) |
| `tools/list` | 返回已注册 tool 列表(含 JSON Schema),支持 cursor 分页 |
| `tools/call` | 校验参数(zod safeParse),调用 handler(传 `sendLogging` / `sendProgress` extra),返回结果 |
| `resources/list` | 返回已注册资源列表(uri/name/description/mimeType),支持 cursor 分页 |
| `resources/read` | 调用资源 read handler(传 `sendLogging` / `sendProgress` extra),返回 contents |
| `prompts/list` | 返回已注册 prompt 列表(name/description/arguments),支持 cursor 分页 |
| `prompts/get` | 调用 prompt get handler(传 `sendLogging` / `sendProgress` extra),返回 messages |
| `logging/setLevel` | 设置 session 日志级别,过滤后续 `notifications/message` 推送 |
| `resources/subscribe` | 客户端订阅资源 URI 变更通知,返回空结果 |
| `resources/unsubscribe` | 客户端取消订阅,返回空结果 |
| `resources/templates/list` | 返回已注册的资源模板列表(uriTemplate/name/description/mimeType) |
| `completion/complete` | 调用注册的 completion handler,返回候选值数组(无 capability 声明,找不到时返回 MethodNotFound) |
| `ping` | 返回空结果 |

## Pagination

`tools/list`、`resources/list`、`prompts/list` 支持 cursor-based 分页,靠齐官方 SDK:

- 请求 params 含 `cursor?: string`(不透明字符串,首次请求不传)
- 响应 result 含 `nextCursor?: string`(有更多项时返回,无更多项不返回)
- cursor 实现:base64 编码的偏移量字符串(如 `base64("10")` → `"MTA="`)
- 默认每页 100 项,可通过 `McpServerOptions.defaultPageSize` 配置

业务方无需关心分页逻辑——注册时只管 set,框架自动切片。

## Logging

服务端通过 `logging` capability 声明日志推送能力,业务方在 tool/resource/prompt handler 中通过 `extra.sendLogging` 主动推送日志到客户端的 GET SSE 流。

### logging/setLevel

客户端通过 `logging/setLevel` 设置 session 的日志级别,服务端只推送 `>=` 该级别的日志。8 个级别(syslog 严重度,从低到高):

```
debug → info → notice → warning → error → critical → alert → emergency
```

- 默认级别:`info`(session 创建时初始化)
- 设置后立即生效,过滤后续 `notifications/message` 推送
- 返回空结果 `{}`

### notifications/message 推送格式

服务端通过 SSE 流推送 `notifications/message`,params 结构:

```ts
{
  level: LoggingLevel,         // 日志级别
  logger?: string,             // 日志源名称(可选,如 'tool:hello')
  data: unknown,               // 日志数据(任意 JSON 可序列化值)
}
```

SSE 行格式:`data: ${JSON.stringify(notification)}\n\n`

### handler extra.sendLogging

`ToolCallExtra` / `ResourceReadExtra` / `PromptGetExtra` 都提供 `sendLogging` 方法:

```ts
mcp.tool('hello', {
  input: { name: z.string() },
  handler: async ({ name }, { sendLogging }) => {
    sendLogging('debug', { msg: 'start', name }, 'tool:hello');
    const result = await doWork(name);
    sendLogging('info', { msg: 'done', result }, 'tool:hello');
    return { content: [{ type: 'text', text: 'ok' }] };
  },
});
```

- `sendLogging(level, data, logger?)` 立即通过 `SessionManager.broadcastToSession` 推送到该 session 的所有 SSE 订阅者
- 若 session 无 SSE 订阅者(GET 流未打开),日志被丢弃(不缓存)
- 若 level 低于 session 当前 `loggingLevel`,日志被丢弃(过滤)
- 不影响 handler 返回值——日志推送是副作用,handler 仍正常返回 JSON-RPC response

### GET SSE 流与订阅者

GET 请求若携带 `Mcp-Session-Id` 头,会在 stream start 时通过 `SessionManager.addSubscriber` 注册订阅者:

- 服务端 `sendLogging` 调用时,通过 `broadcastToSession` 将 `notifications/message` 推送到所有订阅者的 controller
- 客户端断开(stream cancel)时,通过 `removeSubscriber` 注销,避免内存泄漏
- GET 请求无 `Mcp-Session-Id` 时,仅维持心跳连接(不注册订阅者,无法接收推送)

## Progress Notifications

服务端可向客户端推送进度通知(`notifications/progress`),用于长时间运行的操作(如文件上传、批量处理)。

### progressToken 来源

客户端在请求 `_meta.progressToken` 中传入(任意 JSON 值,通常是字符串或数字):

```jsonc
{
  "method": "tools/call",
  "params": {
    "name": "long-task",
    "arguments": {},
    "_meta": { "progressToken": "task-123" }
  }
}
```

服务端从请求 `_meta.progressToken` 提取 token,通过 `notifications/progress` 推送进度:

```jsonc
{
  "jsonrpc": "2.0",
  "method": "notifications/progress",
  "params": {
    "progressToken": "task-123",
    "progress": 50,
    "total": 100
  }
}
```

### handler extra.sendProgress

`ToolCallExtra` / `ResourceReadExtra` / `PromptGetExtra` 都提供 `sendProgress` 方法:

```ts
mcp.tool('long-task', {
  handler: async (_args, { sendProgress }) => {
    for (let i = 0; i < 100; i++) {
      await doStep(i);
      sendProgress(i + 1, 100); // 当前进度 + 总数
    }
    return { content: [{ type: 'text', text: 'done' }] };
  },
});
```

- `sendProgress(progress, total?)` 立即通过 `SessionManager.broadcastToSession` 推送到该 session 的所有 SSE 订阅者
- 若请求未携带 `_meta.progressToken`,`sendProgress` 静默丢弃(无 token 无法关联)
- 若 session 无 SSE 订阅者(GET 流未打开),进度通知被丢弃
- 不影响 handler 返回值——进度推送是副作用

### 推送通道说明

本实现通过 **GET SSE 流** 推送进度通知(与 logging/resource-updated 一致)。
官方 SDK 还支持 POST 请求返回 SSE 流,在响应中内联进度通知——本实现暂不支持此模式,
客户端需打开 GET 流才能接收进度。

## Resource Subscriptions

服务端通过 `resources.subscribe` capability 声明资源订阅能力。客户端可订阅指定 URI 的资源变更通知。

### resources/subscribe

```jsonc
// 请求
{ "method": "resources/subscribe", "params": { "uri": "file://docs/readme" } }
// 响应
{ "result": {} }
```

- 将 URI 加入 session 的 `subscribedResources` 集合
- 重复订阅同一 URI 幂等(Set 自动去重)
- 返回空结果 `{}`

### resources/unsubscribe

```jsonc
{ "method": "resources/unsubscribe", "params": { "uri": "file://docs/readme" } }
// 响应
{ "result": {} }
```

- 从 session 的 `subscribedResources` 移除 URI
- 未订阅的 URI 取消订阅也返回 `{}`(幂等)

### notifications/resources/updated 推送

服务端通过 `server.sendResourceUpdated(uri)` 推送资源变更通知:

```ts
// 应用代码(如文件 watcher 检测到变更)
mcp.sendResourceUpdated('file://docs/readme');
```

推送行为:
- 找出所有 `subscribedResources` 包含该 URI 的 session
- 对每个 session 的所有 SSE 订阅者推送 `notifications/resources/updated`
- SSE 行格式:`data: ${JSON.stringify(notification)}\n\n`
- notification.params: `{ uri: string }`

```jsonc
{
  "jsonrpc": "2.0",
  "method": "notifications/resources/updated",
  "params": { "uri": "file://docs/readme" }
}
```

### capability 协商

`resources.subscribe` capability 在**注册了至少一个 resource 或 resource template** 时自动声明:

```jsonc
{ "resources": { "listChanged": false, "subscribe": true } }
```

未注册任何 resource/template 时不声明 `resources` capability(包括 subscribe)。

## Completion

服务端可注册 completion handler,为客户端提供参数自动补全能力(如 IDE 触发自动补全提示用户填参数)。客户端通过 `completion/complete` 请求获取补全候选值。

### completion 注册 API

```ts
import type { CompletionRef, CompletionHandler } from '@faapi/mcp';

// 为 prompt 的某个参数注册补全
mcp.completion(
  { type: 'ref/prompt', name: 'greet' },
  'userName',
  async (value, ctx) => ({
    values: ['Alice', 'Bob', 'Andy'].filter((n) => n.startsWith(value)),
    total: 3,
    hasMore: false,
  }),
);

// 为 resource template 的某个参数注册补全
mcp.completion(
  { type: 'ref/resource', uri: 'file://docs/{path}' },
  'path',
  async (value) => ({
    values: ['readme', 'guide', 'api'].filter((p) => p.startsWith(value)),
  }),
);
```

参数说明:

- `ref`:`{ type: 'ref/prompt', name: string }` 或 `{ type: 'ref/resource', uri: string }`(对资源模板,uri 是**模板字符串**而非实际 URI)
- `argumentName`:补全的参数名(对应 prompt arguments 中的 name,或 resource template URI 模板中的变量名)
- `handler`:`(value, context) => { values, total?, hasMore? }`
  - `value`:客户端当前已输入的部分字符串(可能为空)
  - `context.arguments`:客户端已填写的其他参数(部分填充,key 为参数名,value 为已填值)
  - 返回 `values`(候选值数组)、`total`(总数,可选)、`hasMore`(是否还有更多,可选)

### completion/complete 请求

客户端通过 `completion/complete` 请求补全:

```jsonc
// 请求
{
  "method": "completion/complete",
  "params": {
    "ref": { "type": "ref/prompt", "name": "greet" },
    "argument": { "name": "userName", "value": "A" },
    "arguments": { "language": "en" }   // 可选:其他已填参数
  }
}
// 响应
{
  "result": {
    "completion": {
      "values": ["Alice", "Andy"],
      "total": 2,
      "hasMore": false
    }
  }
}
```

### capability 协商

按 MCP 2025-06-18 规范,`completion/complete` 不要求声明 capability——客户端直接尝试请求,服务端返回 `MethodNotFound`(-32601) 表示不支持。

### 查找规则

- `(ref.type, ref.name/uri, argumentName)` 三元组唯一定位 handler
- 同一 ref + argumentName 重复注册抛错
- 找不到 handler 时返回 `MethodNotFound`

## Resource Templates

资源模板用于参数化资源(RFC 6570 URI 模板),客户端通过模板构造 URI 再调用 `resources/read`。

### resourceTemplate 注册 API

```ts
mcp.resourceTemplate('file://docs/{path}', {
  name: 'doc',
  description: 'Document by path',
  mimeType: 'text/markdown',
  read: async (uri, params, extra) => {
    // params = { path: 'readme' } (从 URI 模板提取)
    return {
      contents: [{
        uri,
        mimeType: 'text/markdown',
        text: `Content of ${params.path}`,
      }],
    };
  },
});
```

- `uriTemplate`:RFC 6570 URI 模板(本实现支持简单 `{var}` 扩展,不支持操作符前缀如 `{+var}`、`{/var}`)
- `read` handler 接收 `(uri, params, extra)`:
  - `uri`:客户端请求的实际 URI(如 `file://docs/readme`)
  - `params`:从 URI 模板提取的变量映射(如 `{ path: 'readme' }`)
  - `extra`:含 `sessionId` / `sendLogging`

### resources/templates/list

返回已注册的资源模板列表,每项含:

```jsonc
{
  "uriTemplate": "file://docs/{path}",
  "name": "doc",
  "description": "Document by path",
  "mimeType": "text/markdown"
}
```

### resources/read 匹配顺序

1. 先在 `resources` Map 中查找**精确 URI 匹配**
2. 找不到时,遍历 `resourceTemplates`,用 URI 模板匹配实际 URI
3. 第一个匹配成功的模板的 read handler 被调用,传入提取的 params
4. 都不匹配则返回 `InvalidParams`(`Unknown resource`)

### URI 模板匹配规则

本实现支持简单的 `{var}` 扩展:

- 模板 `file://docs/{path}` 匹配 `file://docs/readme` → `params = { path: 'readme' }`
- 模板 `file://docs/{path}` 匹配 `file://docs/sub/readme` → `params = { path: 'sub/readme' }`(贪婪匹配到结尾)
- 模板 `git://repo/{owner}/{repo}` 匹配 `git://repo/faapi/mcp` → `params = { owner: 'faapi', repo: 'mcp' }`
- 不支持 RFC 6570 操作符(`{+var}`、`{?var}`、`{/var}` 等)
- 模板必须有至少一个 `{var}` 占位符
- 占位符名称必须为合法标识符 `[A-Za-z_][A-Za-z0-9_]*`

## 错误处理

- 调用未注册的 resource/prompt:返回 `InvalidParams`(`-32602`)
- resources/read 缺少 uri 参数:返回 `InvalidParams`
- prompts/get 缺少 name 参数:返回 `InvalidParams`
- handler 抛错:返回 `InternalError`(`-32603`)
- 未知 method:返回 `MethodNotFound`(`-32601`)

## zod → JSON Schema

使用 zod v4 内置的 `toJSONSchema()` 转换 tool 输入参数为 JSON Schema（MCP 协议要求）。移除 `$schema` 和 `additionalProperties` 字段以兼容 MCP 客户端。

## 相关模块

- [jsonRpc](./jsonRpc.md) — JSON-RPC 消息类型和工具函数
- [session](./session.md) — 会话管理
- [streamableHttp](./streamableHttp.md) — HTTP transport 层调用本模块
