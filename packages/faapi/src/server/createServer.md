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
request → toWebRequest → createContext → matchRoute（提前匹配，见下节）
  → 外层中间件链（compression → cors → helmet → logger → etag → 全局）
  → routePipeline: loadRouteModule（dev 按需模式：先 ensureCompiled 单文件编译再 import）
  → resolveInput
  → getRuntimeSchemaPath(route.filePath, dist, rootDir) → schemaPath
  → if (isDevOnDemandEnabled()): ensureSchemaGenerated 按需生成 zod.js（mtime 缓存复用）
  → validateInput（zod.js safeParse）
  → invokeHandler（洋葱模型中间件 + handler）
  → sendNodeResponse
```

dev 按需模式下，handler.js 由 `loadRouteModule` 先 `ensureCompiled` 编译再 import，zod.js 由 `ensureSchemaGenerated` 触发生成，均在首次请求时完成（详见 [compileOnDemand](../cli/compileOnDemand.md)）。prod 模式跳过 `ensureSchemaGenerated`——build 阶段已固化全部 zod.js。

## 路由匹配提前（全局中间件可见 rawParams）

路由匹配在 `handleRequest` 中、进入外层中间件链**之前**完成（`matchRoute` 纯函数无副作用，提前匹配不改变响应路径）：

- 命中：`ctx.params` 与 `ctx.rawParams` 在 createContext 后立即挂载为匹配的原始段——全局中间件 `await next()` 之前即可读取原始路径参数（此前为空对象）
- 未命中：`match` 为 null 传入 routePipeline，pipeline 内抛 `RouteNotFoundError` / `MethodNotAllowedError`——404/405 响应仍经过完整外层中间件链（CORS 头不丢，行为与既往一致）

## 输入字段口径（转换后 vs 原始）

输入字段二分：**`query` / `params` / `body` 恒为校验转换后的值；`rawQuery` / `rawParams` / `rawBody` 恒为原始值**。同一字段在 ctx、目录中间件、handler 注入所有访问点口径一致。

| 字段 | 类型 | 挂载时机 | 全局中间件 next() 前 | 校验后 |
|------|------|---------|---------------------|--------|
| `ctx.rawQuery` | `URLSearchParams` | createContext | ✅ | 不变（恒原始） |
| `ctx.rawParams` | `Record<string, string>` | 路由匹配后（提前匹配） | ✅ | 不变（恒原始） |
| `ctx.rawBody` | `string \| undefined` | pipeline 解析 body 时 | ❌ undefined（请求体流只能消费一次的物理限制） | 原始文本；GET/HEAD/multipart 恒 undefined |
| `ctx.query` | `Record<string, unknown>` | createContext 先挂原始 query 对象 | 原始对象 | **替换为转换值**（声明字段 coerce + 未声明字段原始打底保留） |
| `ctx.params` | `Record<string, string \| number \| boolean>` | 路由匹配后先挂原始段 | 原始段 | 回写转换值（catch-all 等未声明段原始打底保留） |
| `ctx.body` | `unknown` | pipeline 校验后挂载 | ❌ undefined | 转换值；目录中间件首次可见；GET/HEAD 恒 undefined |

未声明 `query`/`params` 形参的路由无 schema，`ctx.query`/`ctx.params` 保持原始对象不替换（= 未声明拿原始字符串的既往语义）。

## 输入校验覆盖（主输入 + 次输入）

管线在 `validateInput` 处按 schema 存在与否逐路校验，**声明即校验**：

| 输入 | 适用方法 | schema 来源 | 校验后的值去向 |
|------|---------|------------|--------------|
| 主输入（query） | GET/DELETE/HEAD | `<METHOD>Query` | 挂载 `ctx.query`（原始 query 打底合并，未声明字段保留原始字符串），handler 的 query 注入取同一对象 |
| 主输入（body/form） | POST/PUT/PATCH | `<METHOD>Body` | 直接作为 body 注入 handler，并挂载 `ctx.body` |
| 次输入（query） | POST/PUT/PATCH | `<METHOD>Query`（handler 声明 query 形参时收集） | 同主输入 query：挂载 `ctx.query`（声明字段拿到转换值，未声明字段保留原始字符串） |
| 次输入（body/form） | DELETE | `<METHOD>Body`（handler 声明 body/form 形参时收集） | 校验通过后作为 body 注入并挂载 `ctx.body`（Date 字段转换与 POST body 一致）；空请求体（null）与 POST 同路径——有 schema 时 safeParse 失败 422，无 schema 透传 |
| params | 全部 | `<METHOD>Params`（handler 声明 params 形参时收集） | coerce 后回写 `ctx.params`（原始 params 打底合并，防剥 catch-all 段） |

- 某路输入未声明对应形参 → 无 schema → `validateInput` 原样透传（`ctx.query` 保持原始对象、DELETE body 注入原始解析值），行为与既往一致
- 校验失败统一抛 `ValidationError`（422/400 由 issue code 推导）
- 请求体解析支持三种 Content-Type（POST/PUT/PATCH 与 DELETE 的 body 对称）：JSON（默认）、form-urlencoded（值均为 string）、multipart/form-data

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

- **与 SSE 的关系**：SSE 路径的 `ctx.sse().aborted`（stream cancel 检测）保持独立并存——SSE handler 用 `writer.aborted` 轮询，非流式 handler 用 `ctx.request.signal`，互不影响。SSE 首次写入提前接管后（见下节），断开 → `res` close → destroy 源流 → stream cancel，`writer.aborted` 在流式期间实时变 true，handler 推送循环可即时退出
- 信号触发后框架不自动中断 handler 执行，由业务代码通过 signal 自行决定中止点（fetch 传参 / `signal.addEventListener` / `throw signal.reason`）

## SSE 提前接管（首次写入即下发）

SSE Response 若等 handler 返回后才交给 `sendNodeResponse`，流式期间 `ReadableStream` 无消费者，所有字节积压到 handler 结束才一次性到达——流式语义失效（LLM 打字机/思考过程增量全部变成一次性到达），`writer.aborted` 也因 cancel 永不触发而恒 false。因此 `handleRequest` 在 ctx 创建后安装内部钩子 `__earlyRespond(response)`：

1. `ctx.sse()` 创建 writer 时把钩子接到**首次写入**（`send`/`sendRaw`/`sendError`）——首次写入触发 `mergeMeta(当前 meta)` 后 fire-and-forget 调 `sendNodeResponse` 接管 `res`，并置 early-sent 标记（不 await 完成，finish 在流关闭后）
2. **正常返回路径**：early-sent 时跳过 `sendSuccessResponse`——响应已上线，handler 返回值及中间件 `await next()` 之后替换的响应被忽略（日志等副作用仍正常）
3. **错误路径**：early-sent 时不再发错误响应（头已发出）——流由 writer 关闭自然收尾，仍触发 `onError` 副作用（流式中断的告警观测点）
4. **无钩子场景**（`app.inject()`、测试直调 `invokeHandler`）：回落为 handler 返回后一次交出——`app.inject()` 等流结束整体返回，最终字节序列与真实请求一致

meta（含 CORS 头，均在 handler 之前经 `ctx.setHeader` 写入）在首次写入时刻合并；首次写入之后的 `setStatus`/`setHeader` 不再生效。compression/etag 均按 Content-Type 跳过 `text/event-stream`，不会触碰已接入管道的 body 流。

## 相关模块

- `matchRoute.ts` - 路由匹配
- `loadRouteModule.ts` - 加载路由模块（dev 按需模式下先 `ensureCompiled` 再 import）
- `resolveInput.ts` - 解析输入
- `invokeHandler.ts` - 调用 handler、导出 compose/mergeMeta 用于全局中间件调度
- `../validator/validateInput.ts` - 参数校验（zod safeParse）
- `../cli/compileOnDemand.ts` - dev 按需生成 zod.js（`ensureSchemaGenerated`）
- `../cli/generateSchemaFiles.ts` - `getRuntimeSchemaPath` 计算 zod.js 路径
