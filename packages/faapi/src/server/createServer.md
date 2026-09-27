# createServer

一句话概括：创建 HTTP 服务器并处理请求分发。dev 按需模式下，`validateInput` 之前会调 `ensureSchemaGenerated` 按需生成 zod.js。

## 为什么需要

将路由系统与 Node.js HTTP 服务器结合，处理请求分发、模块加载、参数校验、响应发送的完整链路。

## 使用场景

- 启动 HTTP 服务
- 请求分发到对应 handler
- 错误处理和响应发送
- CORS 作为标准中间件走洋葱模型（preflight 拦截、非 preflight 附加头后放行）
- onError 钩子：错误响应发出后触发，用于副作用（日志/告警），不修改已发出的响应（参考 Fastify onError 语义）
- 错误兜底链：全局错误中间件 try/catch 未拦截 → 内置 formatErrorResponse 兜底 → 仍失败则最简 500 JSON
- **dev 按需模式**：`handleRequest` 在 `validateInput` 之前调 `ensureSchemaGenerated` 按需生成 zod.js

## 请求处理链路

```
request → toWebRequest → createContext → matchRoute
  → loadRouteModule（dev 按需模式：先 ensureCompiled 单文件编译再 import）
  → resolveInput
  → getRuntimeSchemaPath(route.filePath, dist, rootDir) → schemaPath
  → if (isDevOnDemandEnabled()): ensureSchemaGenerated 按需生成 zod.js（mtime 缓存复用）
  → validateInput（zod.js safeParse）
  → invokeHandler（洋葱模型中间件 + handler）
  → sendNodeResponse
```

dev 按需模式下，handler.js 由 `loadRouteModule` 先 `ensureCompiled` 编译再 import，zod.js 由 `ensureSchemaGenerated` 触发生成，均在首次请求时完成（详见 [compileOnDemand](../cli/compileOnDemand.md)）。prod 模式跳过 `ensureSchemaGenerated`——build 阶段已固化全部 zod.js。

## 输入校验覆盖（主输入 + 次输入）

管线在 `validateInput` 处按 schema 存在与否逐路校验，**声明即校验**：

| 输入 | 适用方法 | schema 来源 | 校验后的值去向 |
|------|---------|------------|--------------|
| 主输入（query） | GET/DELETE/HEAD | `<METHOD>Query` | 挂载 `__validatedQuery`，handler 的 query 注入优先取用（原始 query 打底合并，未声明字段保留原始字符串） |
| 主输入（body/form） | POST/PUT/PATCH | `<METHOD>Body` | 直接作为 body 注入 handler |
| 次输入（query） | POST/PUT/PATCH | `<METHOD>Query`（handler 声明 query 形参时收集） | 同主输入 query：挂载 `__validatedQuery`（声明字段拿到转换值，未声明字段保留原始字符串） |
| 次输入（body/form） | DELETE | `<METHOD>Body`（handler 声明 body/form 形参时收集） | 校验通过后作为 body 注入（Date 字段转换与 POST body 一致）；空请求体（undefined）跳过校验 |
| params | 全部 | `<METHOD>Params`（handler 声明 params 形参时收集） | coerce 后回写 `ctx.params`（原始 params 打底合并，防剥 catch-all 段） |

- 某路输入未声明对应形参 → 无 schema → `validateInput` 原样透传（query 注入回退 `queryToObject` 裸字符串、DELETE body 注入原始解析值），行为与 6.19.x 及之前一致
- 校验失败统一抛 `ValidationError`（422/400 由 issue code 推导）

## 客户端断连信号（ctx.request.signal）

每个请求创建一个 `AbortController`，其 signal 传入 `toWebRequest` 构造的 Web Request——即 `ctx.request.signal` 是**已接线客户端断连**的标准 Web AbortSignal：

```
handleRequest
  → new AbortController()
  → toWebRequest(req, bodyLimit, controller.signal)   // signal 进入 Request
  → res.on('close', () => { if (!res.writableEnded) controller.abort() })
```

- **触发时机**：`res` 的 `close` 事件且 `writableEnded === false`（响应未写完连接就断开 = 客户端提前断连）时 abort；响应正常完成后 `close` 也触发（keep-alive 场景），但此时 `writableEnded === true`，不会误触发
- **典型用法**：非流式 handler 的长耗时上游调用携带该信号，客户端取消即中止上游（LLM 网关转发、批量任务等）：

```ts
export async function POST(ctx, body) {
  const upstream = await fetch('https://api.example.com/slow', {
    method: 'POST',
    body: JSON.stringify(body),
    signal: ctx.request.signal,  // 客户端断开 → 上游 fetch 立即中止
  });
  return upstream.json();
}
```

- **与 SSE 的关系**：SSE 路径的 `ctx.sse().aborted`（stream cancel 检测）保持独立并存——SSE handler 用 `writer.aborted` 轮询，非流式 handler 用 `ctx.request.signal`，互不影响
- 信号触发后框架不自动中断 handler 执行，由业务代码通过 signal 自行决定中止点（fetch 传参 / `signal.addEventListener` / `throw signal.reason`）

## 相关模块

- `matchRoute.ts` - 路由匹配
- `loadRouteModule.ts` - 加载路由模块（dev 按需模式下先 `ensureCompiled` 再 import）
- `resolveInput.ts` - 解析输入
- `invokeHandler.ts` - 调用 handler、导出 compose/mergeMeta 用于全局中间件调度
- `../validator/validateInput.ts` - 参数校验（zod safeParse）
- `../cli/compileOnDemand.ts` - dev 按需生成 zod.js（`ensureSchemaGenerated`）
- `../cli/generateSchemaFiles.ts` - `getRuntimeSchemaPath` 计算 zod.js 路径
