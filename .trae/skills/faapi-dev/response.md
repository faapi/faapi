# 场景:统一响应格式与错误处理

## 何时加载

用户希望统一接口响应格式(如 `{ data }` / `{ error: { code, message } }`)、自定义错误响应格式,或了解 handler 返回值如何被框架包裹成响应。

## 框架设计

框架内置统一响应包装能力,默认开启:

| 能力 | 触发方式 | 默认行为 |
|------|---------|---------|
| 自动包裹 | handler `return data`(非 Response,含 null/undefined) | 用 `config.response.ok`(默认 `(data) => ({ data })`)包裹 |
| `ctx.ok(data)` | handler `return ctx.ok(data)` | 显式包裹,等价于 `return data`,返回 Response 不被再次包裹 |
| `ctx.fail(options)` | handler `return ctx.fail({...})` | 返回错误 Response,不被包裹 |
| `config.response` | `faapi.config.ts` 配置 | 自定义 ok/fail,未配置用框架默认 |

## 响应格式约定

参考业界通用做法(Stripe / Facebook Graph / JSON:API / Twitter v2):

| 响应 | 格式 | 说明 |
|------|------|------|
| 成功 | `{ data: T }` | 单字段 envelope,HTTP 2xx 已表达成功语义,无需 `code:0`/`message:'success'` 冗余字段 |
| 失败 | `{ error: { code, message } }` | 与框架内置 `formatErrorResponse` 结构一致(见下方说明) |

### HTTP status 与 error.code 的语义分工

**关键原则:`error.code` 是业务错误码(字符串),与 HTTP status 是两个独立维度,无关联。**

- **HTTP status** 表达**错误大类**(4xx 客户端错误 / 5xx 服务端错误),粗粒度,控制 HTTP 响应状态码
- **`error.code`** 表达**具体业务错误**,定位到"是哪个错误",细粒度,是响应 body 里的字段

两者独立:status 和 code 均可独立省略,无推导关系。`ctx.fail({ status: 404, message })` 不会自动填充 code,body 里就不含 code 字段。正确的 `code` 应该能让前端**区分同一 HTTP status 下的不同业务场景**。

**Stripe 的规范做法**(同一 HTTP 402 可对应多种业务错误码):

```json
HTTP 402
{
  "error": {
    "code": "card_declined",        ← 业务错误码:定位到"卡被拒"
    "message": "Your card was declined."
  }
}
```

同样是 HTTP 402,可能是 `card_declined` / `expired_card` / `insufficient_funds`,前端按 `code` 做不同 UI 提示。

**框架 formatErrorResponse 也遵循此原则**:

```json
HTTP 422
{
  "error": {
    "code": "VALIDATION_ERROR",     ← 字符串业务错误码(非 422)
    "message": "Invalid query parameters",
    "issues": [...]                 ← 进一步定位到字段
  }
}
```

HTTP 422 表达"语义错误"大类,`code: "VALIDATION_ERROR"` 表达"校验失败"小类,`issues` 定位到具体字段。code 字符串 ≠ HTTP status,互补不冗余。

### error.code 的类型选择

| 类型 | 示例 | 优点 | 缺点 |
|------|------|------|------|
| **字符串错误码**(推荐) | `'USER_NOT_FOUND'` / `'AUTH_EXPIRED'` | 可读、可扩展、与框架 `formatErrorResponse` 一致 | 需维护错误码字典 |
| 数字错误码 | `10001` / `10002` | 紧凑 | 不可读,需查表才知道含义 |

推荐用**字符串错误码**,与框架 `formatErrorResponse` 的 `code` 类型一致,handler 主动错误和框架校验错误走同一格式,前端只写一套解析逻辑。

## 自动包裹机制

`invokeHandler` 在 handler 执行后调用 `wrapResult` 处理返回值,规则:

| 返回值类型 | 处理方式 | 响应 |
|-----------|---------|------|
| `Response` 对象 | 原样透传(合并 ctx.meta)| `ctx.ok`/`ctx.fail`/`ctx.json`/`ctx.html`/`ctx.redirect`/`ctx.sse` 返回值均属此类 |
| 其他值(含 `null`/`undefined`) | 用 `config.response.ok` 包裹(默认 `(data) => ({ data })`) | `{ data: value }`(`null` → `{ data: null }`,`undefined` → `{}`) |

`null`/`undefined` 也会被包裹为 `{ data: null }` / `{ data: undefined }`(后者 JSON 序列化后为 `{}`),不再返回 204 No Content。如需 204,handler 应显式返回 Response 对象(如 `return new Response(null, { status: 204 })`)。

**`ctx.ok(data)` 返回的是 Response 对象**,所以 handler 用 `return ctx.ok(data)` 或 `return data` 最终响应一致(都是 `ok(data)` 的结果),不会双重包裹。

## ctx.ok / ctx.fail 用法

### ctx.ok(data) — 显式包裹成功响应

```ts
// 推荐:直接 return data,框架自动包裹
export function GET() {
  return { id: 1, name: 'Alice' };
  // 响应: { data: { id: 1, name: 'Alice' } }
}

// 等价写法:显式 return ctx.ok(data)
export function GET2(ctx) {
  return ctx.ok({ id: 1, name: 'Alice' });
  // 响应: { data: { id: 1, name: 'Alice' } }
}
```

### ctx.fail(options) — 返回错误响应

对象形式参数,`status` 和 `code` 均可省略,两者独立无关联:

```ts
// 仅 message:HTTP 默认 500,body 不含 code 字段
return ctx.fail({ message: '出错' });
// 响应: HTTP 500, { error: { message: '出错' } }

// status + message:body 不含 code 字段
return ctx.fail({ status: 404, message: '用户不存在' });
// 响应: HTTP 404, { error: { message: '用户不存在' } }

// status + code + message:完整错误信息
return ctx.fail({ status: 404, code: 'USER_NOT_FOUND', message: '用户不存在' });
// 响应: HTTP 404, { error: { code: 'USER_NOT_FOUND', message: '用户不存在' } }

// code + message(无 status):HTTP 默认 500
return ctx.fail({ code: 'AUTH_EXPIRED', message: '登录已过期' });
// 响应: HTTP 500, { error: { code: 'AUTH_EXPIRED', message: '登录已过期' } }
```

`FailOptions` 类型:

```ts
interface FailOptions {
  status?: number;   // HTTP 状态码(可选,省略时默认 500)
  code?: string;     // 业务错误码(可选,省略时响应 body 里不含 code 字段)
  message: string;   // 人类可读错误描述(必填)
}
```

> `status` 和 `code` 是两个独立维度,无推导关系。`status` 控制 HTTP 响应状态码,`code` 是 body 里的业务错误码字段。省略哪个,响应里就没有对应的字段(默认 fail 函数只把非 undefined 的字段放入 error 对象)。

### handler 综合示例

```ts
// api/user/handler.ts
export interface User {
  id: string;
  name: string;
}

export interface CreateUserBody {
  name: string;
}

// 成功响应:直接 return data,框架自动包裹为 { data }
export function GET(): User {
  return { id: '1', name: 'foo' };
  // 响应: { data: { id: '1', name: 'foo' } }
}

// 错误响应:return ctx.fail(...) 返回 Response,不被包裹
export function POST(ctx, body: CreateUserBody): User {
  if (!body.name) {
    // status + code + message:完整错误信息
    return ctx.fail({ status: 400, code: 'NAME_REQUIRED', message: 'name is required' });
  }
  if (body.name === 'admin') {
    // HTTP 403 + 显式 code 'PERMISSION_DENIED' 定位到"禁止创建管理员"
    return ctx.fail({ status: 403, code: 'PERMISSION_DENIED', message: '禁止创建管理员账号' });
  }
  return { id: '2', name: body.name };
  // 响应: { data: { id: '2', name: body.name } }
}
```

> handler 返回类型注解为业务数据类型(如 `User`),框架自动包裹后实际响应是 `{ data: User }`。`pnpm typecheck` 不检查响应包装结构(esbuild 只编译不检查类型),如需对齐实际响应类型,可声明 `ApiSuccess<T>` 类型并 `return ctx.ok(data)`。

## 自定义包装结构(config.response)

默认包装结构为 `{ data }` / `{ error: { message, ...code? } }`。业务方可在 `faapi.config.ts` 通过 `config.response` 自定义:

```ts
// faapi.config.ts
import type { FaapiConfig } from '@faapi/faapi';

export default {
  response: {
    // 自定义成功包装(默认 (data) => ({ data }))
    ok: (data) => ({ code: 0, data }),

    // 自定义错误包装(默认:省略的字段不放入 error 对象)
    // 接收 { status?, code?, message },返回 body
    // 注意:status 和 code 均可能为 undefined(用户调用 ctx.fail 时省略则不传)
    fail: ({ status, code, message }) => ({ error: { code, message } }),
  },
} satisfies FaapiConfig;
```

配置规则:

- `config.response` 整体可选,未配置时用框架默认实现
- `ok` / `fail` 各字段均可选,按需覆盖
- `ok(data)` 接收 handler 返回值,返回 body(任意可 JSON 序列化结构)
- `fail({ status?, code?, message })` 接收错误对象(字段可能为 undefined),返回 body
- 默认 `fail` 实现只把非 undefined 的字段放入 error 对象:`{ error: { message, ...code? } }`
- 自定义 `fail` 时注意处理 `code` 为 undefined 的情况(如上例始终放 code,则 `ctx.fail({ message })` 响应里 code 为 undefined)

## ctx.json — 绕过 ok 封装

`return data` / `ctx.ok(data)` 会用 `config.response.ok` 自动包裹响应(默认 `{ data: T }`,自定义后可能是 `{ code:0, data:{...} }` 等)。但有些场景需要返回**不被包裹的原始 JSON**,直接用 `ctx.json(data, status?)`:

| 返回方式 | 是否经过 ok 封装 | 典型场景 |
| --- | --- | --- |
| `return data` | 是(`config.response.ok(data)`) | 业务 API,默认统一响应格式 |
| `return ctx.ok(data)` | 是(同上,显式包裹) | 业务 API,显式包裹 |
| **`return ctx.json(data)`** | **否,原样序列化** | 透传第三方协议响应,不能被业务层包装 |

`ctx.json` 返回 `Response` 对象,`wrapResult` 原样透传(见[自动包裹机制](#自动包裹机制)表),不会被 `config.response.ok` 二次包装。

### 典型场景:LLM 中转网关

LLM 中转 handler 需要直接透传上游 LLM 厂商的 **OpenAI 兼容响应**(`{choices:[...], usage:{...}}`),不能被 `ok()` 包一层 `{code:0, data:{...}}`——否则下游 OpenAI 兼容客户端解析 `json.choices` 会拿到 `undefined`:

```ts
// src/api/chat/completions/handler.ts(LLM 网关项目)
export async function POST(ctx, body) {
  const upstream = await fetch('https://api.openai.com/v1/chat/completions', { ... });
  const openaiResp = await upstream.json();  // { choices:[...], usage:{...} }

  // ❌ return openaiResp → 被 config.response.ok 包装为 { code:0, data:{choices:[...]} }
  //    下游 OpenAI 客户端读 json.choices 拿不到,抛 "Empty choices in response"

  // ✅ ctx.json 原样序列化,返回标准 OpenAI 响应
  return ctx.json(openaiResp);
}
```

流式 LLM 转发用 `ctx.sse()` 直接透传上游 SSE chunk,同样不经 ok 封装:

```ts
export async function POST(ctx, body) {
  const upstream = await fetchUpstreamStream(body);
  const sse = ctx.sse();
  for await (const chunk of upstream) {
    sse.send({ data: chunk });  // 透传上游 SSE data,原样不包装
  }
  sse.close();
}
```

### 其他场景

- **Webhook 回调**:第三方要求严格格式(如企微回调要 `{ errcode:0, errmsg:'ok' }`,不能多包一层 `data`)
- **JSON-RPC / gRPC-Web 等非 REST 协议**:响应结构由协议规定,不能套业务 envelope
- **代理透传**:把上游响应原样回传(如反向代理某 OpenAPI)
- **自定义 issues 字段的错误响应**:标准 `ctx.fail` 不支持 `issues`,需 `ctx.json` 自行构造(见下方[全局错误中间件](#全局错误中间件--自定义错误响应)示例)

### 不要滥用

业务 API 应坚持 `return data` / `ctx.ok(data)` 走统一包装,保证前端一套解析逻辑。只在「响应结构由第三方协议规定,不能被业务 envelope 包装」时才用 `ctx.json`。

## 全局错误中间件 — 自定义错误响应

handler 抛出的错误(非 `ctx.fail` 返回)由全局中间件 `try/catch next()` 捕获,转成错误 Response:

```ts
// faapi.config.ts
import type { FaapiMiddleware, FaapiConfig } from '@faapi/faapi';
import { ValidationError } from '@faapi/faapi';

const errorHandler: FaapiMiddleware = async (ctx, next) => {
  try {
    await next();
  } catch (err) {
    // 处理关心的错误,其余走框架兜底
    if (err instanceof ValidationError) {
      // 与框架 formatErrorResponse 格式一致:code 用框架字符串错误码
      return ctx.json(
        { error: { code: err.code, message: err.message, issues: err.issues } },
        err.statusCode,
      );
    }
    // 其他错误:HTTP 500 表达"服务端错误"大类,可用 ctx.fail 返回
    const message = err instanceof Error ? err.message : 'Unknown error';
    return ctx.fail({ status: 500, message });
  }
};

export default {
  middlewares: [errorHandler],
} satisfies FaapiConfig;
```

> 上例中 `ValidationError` 来自 `@faapi/faapi`,可直接 `instanceof`。`err.code` 是框架定义的字符串错误码(如 `'VALIDATION_ERROR'`),`err.statusCode` 是 HTTP 状态码。注意 `code` 与 `statusCode` 互补,不相等。

### 项目自定义错误类

业务自定义错误类(如 `AuthError`/`AdminError`),由注入器或 handler 抛出,全局中间件捕获后用 `ctx.fail` 或 `ctx.json` 转 HTTP 响应。直接 `import` 项目错误类并用 `instanceof` 判断:

```ts
// src/lib/auth/errors.ts
export class AuthError extends Error {
  constructor(message = '未登录') {
    super(message);
    this.name = 'AuthError';
  }
}
```

```ts
// faapi.config.ts
import type { FaapiMiddleware, FaapiConfig } from '@faapi/faapi';
import { AuthError, AdminError } from './src/lib/auth/errors';

const authErrorHandler: FaapiMiddleware = async (ctx, next) => {
  try {
    await next();
  } catch (err) {
    if (err instanceof AuthError) {
      // HTTP 401 = "未认证"大类,code = 'AUTH_REQUIRED' 定位到"需要登录"
      return ctx.fail({ status: 401, code: 'AUTH_REQUIRED', message: err.message });
    }
    if (err instanceof AdminError) {
      // HTTP 403 = "禁止访问"大类,code = 'PERMISSION_DENIED' 定位到"需要管理员权限"
      return ctx.fail({ status: 403, code: 'PERMISSION_DENIED', message: err.message });
    }
    throw err; // 其余错误走框架兜底
  }
};

export default {
  middlewares: [authErrorHandler],
} satisfies FaapiConfig;
```

config 与 routes 共享同一份编译产物,`instanceof` 跨边界生效。

## 错误兜底链

```
handler 抛错
  ↓
全局中间件 try/catch next() 拦截?  → 是 → 返回自定义错误响应(ctx.fail / ctx.json)
  ↓ 否
框架内置 formatErrorResponse 兜底(ValidationError → { error: { code, message, issues } })
  ↓ 仍失败
最简 500 JSON 响应
  ↓ 响应发出
lifecycle.onError 副作用(日志/告警,不修改已发出的响应)
```

## 常见坑点

### 1. 中间件 catch 后忘记 return

```ts
// ❌ 没返回,错误响应被丢弃,继续走兜底链
const errorHandler: FaapiMiddleware = async (ctx, next) => {
  try {
    await next();
  } catch (err) {
    ctx.fail({ status: 500, message: 'error' });  // 没有 return
  }
};

// ✅ 必须 return Response 才能拦截
const errorHandler: FaapiMiddleware = async (ctx, next) => {
  try {
    await next();
  } catch (err) {
    return ctx.fail({ status: 500, message: 'error' });
  }
};
```

### 2. 自动包裹场景下手动包一层导致双重包裹

```ts
// ❌ 手动包一层 { data },框架再用 ok(data => ({ data })) 包裹,变成 { data: { data: {...} } }
export function GET() {
  return { data: { id: 1 } };
  // 响应: { data: { data: { id: 1 } } } ← 双重包裹
}

// ✅ 直接 return 业务数据,让框架包裹
export function GET() {
  return { id: 1 };
  // 响应: { data: { id: 1 } }
}

// ✅ 或显式 return ctx.ok(data)(返回 Response,不会被再次包裹)
export function GET(ctx) {
  return ctx.ok({ id: 1 });
  // 响应: { data: { id: 1 } }
}
```

### 3. 中间件包装破坏类型一致性

```ts
// ⚠️ 全局中间件包装 handler 返回值,handler 类型 ≠ 实际响应类型
// 框架已内置自动包裹,不要在中间件里再包一层
const wrapResponse: FaapiMiddleware = async (ctx, next) => {
  await next();
  // 此模式下 TypeScript 无法感知包装结构,AST schema 也无法分析
};

// 推荐:用框架内置自动包裹,或 handler 内 return ctx.ok(data)
```

### 4. try/catch 未捕获异步错误

```ts
// ❌ next() 异步抛错不会被同步 try/catch 捕获
try {
  next();  // 忘记 await
} catch (err) {
  // 永远不会进入
}

// ✅ await next() 才能被 try/catch 捕获
try {
  await next();
} catch (err) {
  return ctx.fail({ status: 500, message: 'error' });
}
```

## 检查清单

- [ ] handler 直接 `return data`(非 Response)由框架自动包裹,不要再手动包一层 `{ data }`
- [ ] 错误响应用 `return ctx.fail({ status?, code?, message })`,不要 `return` 一个普通错误对象(会被当成 data 包裹)
- [ ] 全局错误中间件 `try/catch next()` 后 `return ctx.fail(...)` / `return ctx.json(...)` 拦截错误
- [ ] 中间件 `await next()` 不能漏掉 await
- [ ] 未处理的错误让框架内置 `formatErrorResponse` 兜底
- [ ] `error.code` 是字符串业务错误码,与 HTTP status 互补,不要用 status 数字
- [ ] `pnpm typecheck` 通过

## 相关场景

- [middleware.md](./middleware.md) — 中间件洋葱模型、`try/catch next()` 错误捕获
- [config.md](./config.md) — `response` / `middlewares` 字段配置
- [lifecycle.md](./lifecycle.md) — `onError` 副作用钩子(响应发出后触发)
- [route.md](./route.md) — handler 返回值类型注解
- [debug.md](./debug.md) — 400/500 错误排查
