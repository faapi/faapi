# schemaServer

一句话概括：通过 MCP 协议（Streamable HTTP）以 resource 形式暴露路由 schema 供 AI 助手查询

## 为什么需要

AI-Native 定位，LLM 可直接查询 API 接口定义，无需手动提供文档

## 使用场景

在 `faapi.config.ts` 中声明插件即启用，无需额外环境变量控制；插件在 `/mcp` 路径挂载 MCP 端点（Streamable HTTP transport），AI 助手通过 HTTP 连接查询。

提供两种 MCP 能力：

- **resources**：每个路由注册为静态 resource + 按方法过滤的 resourceTemplate，支持 `resources/list` / `resources/read` / `resources/subscribe`
- **completion**：为 resource template 的参数提供自动补全候选值

**为什么用 resource 而非 tool**：查 schema 本质是读数据（resource 语义），不是执行动作（tool 语义）。AI 客户端（Claude Desktop / Cursor 等）对 resource 有原生 UI 展示（侧栏树状列表），可缓存列表，支持 subscription 接收变更通知——这些 tool 都做不到。

## 依赖

- `@faapi/mcp` — 纯手写 MCP Server SDK，提供 `createMcpServer`、`createMcpNodeHandler` 等能力，不依赖 `@modelcontextprotocol/sdk`
- `@faapi/faapi`（`buildRouteSchemas`）— 生成路由 schema

> @faapi/schema 为可选扩展包,需单独安装（`pnpm add @faapi/schema`）。CLI 启动时动态加载——未安装时自动跳过,不影响核心功能。

## 架构

```
插件 setup
  → createSchemaServer（注册 resource + resourceTemplate + completion）
  → createMcpNodeHandler（包装为 Node 请求处理函数）
  → ctx.wrapHandler（拦截 /mcp 路径，交给 MCP handler）
  → handleMcpRequest（POST/GET/DELETE → JSON-RPC 分发）
  → McpServer.handleJsonRpc（initialize / resources/* / completion/complete）
  → getSchemas（getRoutes() 取最新路由 → 引用比较检测变更 → 重建或返回缓存）
    → 路由变更时推送 notifications/resources/list_changed 给所有 session
```

## Resource 体系

### 静态 resource（每个路由一个）

每个已知路由注册为一个 resource：

- URI：`faapi://route/{METHOD}{PATH}`（path 保留前导 `/`）
  - 示例：`faapi://route/GET/api/user`、`faapi://route/POST/api/auth/login`
- name：`{METHOD} {PATH}`（如 `GET /api/user`）
- mimeType：`application/json`
- read：返回该路由的完整 schema（含 inputs/properties）

```jsonc
// resources/read 响应
{
  "contents": [{
    "uri": "faapi://route/GET/api/user",
    "mimeType": "application/json",
    "text": "{\"method\":\"GET\",\"path\":\"/api/user\",\"inputs\":[...]}"
  }]
}
```

### Resource Template（按方法过滤）

- 模板：`faapi://routes/by-method/{method}`
- name：`routes-by-method`
- read：返回该方法的所有路由列表（JSON 数组）
- 客户端调用 `faapi://routes/by-method/GET` → 返回所有 GET 路由

```jsonc
// resources/read 响应
{
  "contents": [{
    "uri": "faapi://routes/by-method/GET",
    "mimeType": "application/json",
    "text": "[{\"method\":\"GET\",\"path\":\"/api/user\",...}]"
  }]
}
```

method 不合法（非 HTTP 方法）时返回空数组（无匹配路由）。

### resources/list 返回

仅返回静态 resource（每个路由一个，按 method + path 字母序）。resource template 通过 `resources/templates/list` 单独列出。

### resources/read 匹配优先级

1. 先在 `resources` Map 中查找**精确 URI 匹配**（静态路由 resource）
2. 找不到时,遍历 `resourceTemplates`,用 URI 模板匹配
3. 都不匹配则返回 `InvalidParams`（`Unknown resource`）

## Completion

为 resource template 的 `method` 参数注册补全 handler：

```ts
mcp.completion(
  { type: 'ref/resource', uri: 'faapi://routes/by-method/{method}' },
  'method',
  async (value) => ({
    values: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']
      .filter(m => m.startsWith(value.toUpperCase())),
  }),
);
```

客户端在 IDE 场景下输入 `faapi://routes/by-method/G` 时,服务端返回 `[GET]` 候选值。

## Resource Subscriptions

### listChanged 配置

`createMcpServer` 设置 `resourcesListChanged: true`，声明 resource 列表可变：

```jsonc
// initialize 响应
{ "capabilities": { "resources": { "listChanged": true, "subscribe": true } } }
```

### 变更推送策略

`getSchemas()` 通过路由数组引用比较检测变更（dev `reloadRoutes` 创建新数组即触发）。检测到变更时：

1. 调用 `mcp.notifyResourcesListChanged()` 推送 `notifications/resources/list_changed` 给所有 session
2. 客户端收到后重新 `resources/list` 拉取最新列表

**已知限制**：变更检测发生在下次请求处理时（`getSchemas()` 调用时机），非实时推送。如需实时感知路由变化，需 faapi 框架提供 `onReloadRoutes` 钩子（后续可扩展）。

### resources/subscribe

客户端可订阅指定 resource URI 的变更通知（API 可用，订阅集合由 mcp 维护）：

```jsonc
// 请求
{ "method": "resources/subscribe", "params": { "uri": "faapi://route/GET/api/user" } }
// 响应
{ "result": {} }
```

**当前实现限制**：因 faapi 框架尚未提供 `onReloadRoutes` 钩子，服务端无法实时感知路由变化并推送 `notifications/resources/updated`。订阅 API 仍可用（幂等加入 session 订阅集合），实际推送依赖 `listChanged` 通道——客户端收到 `notifications/resources/list_changed` 后应重新 `resources/list` + `resources/read` 刷新。后续框架接入 `onReloadRoutes` 钩子后再补齐 `updated` 推送。

## 缓存与 dev 热替换

`createSchemaServer` 接收 `getRoutes: () => RouteManifest` getter（非快照），通过路由数组引用比较检测变更：

- 首次查询：`getRoutes()` 返回当前路由数组 → `buildRouteSchemas` 构建 → 缓存 `{ routes, schemas }`
- 后续查询：`getRoutes()` 返回最新数组 → 与缓存引用比较 → 相同则返回缓存，不同则重建
- dev `reloadRoutes` 调用 `updateRoutes` 创建新数组（非原地修改），引用变化触发缓存失效
- `invalidateProgramCache` 在 `reloadRoutes` 中已调用，重建时 AST 分析使用最新源码
- 重建后调用 `notifyResourcesListChanged()` 推送通知给所有已连接 session

## 版本号来源

MCP serverInfo 中的 `version` 字段从 `package.json` 动态读取（模块加载时一次性），通过 `import.meta.url` 解析 `../package.json`。dev 模式下从源文件路径解析，prod 模式下从 `dist/` 解析，均指向包根目录的 `package.json`。版本号随包版本自动同步，无需手动维护。

## capability 协商

initialize 响应 capabilities 根据注册情况动态生成：

```jsonc
{
  "tools": { "listChanged": false },
  "resources": { "listChanged": true, "subscribe": true },
  "logging": {}
}
```

- `tools`：mcp 框架无条件声明(协议完整性),schema 不注册任何 tool,`tools/list` 返回空数组
- `resources.listChanged: true`：路由变化时主动推送 list_changed
- `resources.subscribe: true`：支持 resource 订阅
- `logging: {}`：内置日志推送能力

## 相关模块

- `@faapi/mcp` — MCP Server SDK（tool/resource/prompt/completion 注册、JSON-RPC 分发、Streamable HTTP transport、会话管理）
- `@faapi/faapi`（`buildRouteSchemas`）— 生成路由 schema
- [routeSchema.ts](./routeSchema.md) — 从路由清单构建 RouteInfo[]
