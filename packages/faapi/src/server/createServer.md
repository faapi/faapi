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
