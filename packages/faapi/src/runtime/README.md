# 请求运行时

请求运行时，处理上下文创建、参数注入、handler 调用，是请求处理的核心执行层。

## 模块

| 模块 | 说明 |
| --- | --- |
| [contextTypes.ts](./contextTypes.ts) | 上下文类型定义：FaapiContext、CookieOptions、ResponseMeta |
| [createContext.ts](./createContext.ts) | 从 Request 创建 FaapiContext，初始化 cookie 解析、响应元数据 |
| [invokeHandler.ts](./invokeHandler.ts) | 洋葱模型调度：中间件 → 注入器 → handler → 中间件 |
| [resolveInput.ts](./resolveInput.ts) | 根据 HTTP 方法解析输入：GET/DELETE→query，POST/PUT/PATCH→body/multipart |
| [inputType.ts](./inputType.ts) | HTTP 方法 → 输入类型映射（query/body/none） |
| [sse.ts](./sse.ts) | SSE 流式响应（SseWriter） |
| [wsHandler.ts](./wsHandler.ts) | WebSocket 路由处理 |

## FaapiContext

FaapiContext 提供请求处理所需的所有信息和方法：

| 属性/方法 | 说明 |
| --- | --- |
| `request` | Web Request 对象 |
| `params` | 动态路由参数 |
| `query` | URLSearchParams |
| `headers` | 请求头 |
| `method` | HTTP 方法 |
| `path` | 请求路径 |
| `ip` | 客户端 IP（X-Forwarded-For 优先） |
| `cookies` | 解析后的所有 cookie 键值对 |
| `config` | 应用配置（业务自定义 key 通过 `ctx.config` 访问） |
| `setStatus(status)` | 设置响应状态码 |
| `setHeader(key, value)` | 设置响应头 |
| `setETag(value)` | 设置 ETag 响应头 |
| `json(data, status?)` | 返回 JSON 响应 |
| `html(html, status?)` | 返回 HTML 响应 |
| `redirect(url, status?)` | 返回 302 重定向 Response |
| `sse()` | 创建 SSE writer，流式推送事件 |
| `getCookie(name)` | 读取 cookie 值 |
| `setCookie(name, value, options?)` | 设置 cookie |
| `deleteCookie(name)` | 删除 cookie（设置过期） |

## invokeHandler 执行链（洋葱模型）

```
中间件洋葱（外→内）：mw1.before → mw2.before → ...
  ↓
注入器（按需执行，只执行 handler 参数名匹配的注入器）
  ↓
handler（通过 injectParamsAsync 注入参数）
  ↓
toResponse（将返回值转为 Response）
  ↓
中间件洋葱（内→外）：... → mw2.after → mw1.after
```

中间件不调用 `next()` 即拦截请求；`try/catch` 包裹 `next()` 可捕获内层错误。注入器与中间件解耦，详见 [middleware/README.md](../middleware/README.md)。

## 输入解析策略

- GET/DELETE：从 URL 提取 query 对象
- POST/PUT/PATCH：根据 Content-Type 解析
  - `multipart/form-data`：调用 parseMultipart，返回 `{ fields, files }`
  - 其他：解析 JSON body

## 相关模块

- [injection](../injection/README.md)：参数注入
- [middleware](../middleware/README.md)：中间件系统
- [response](../response/README.md)：响应处理
