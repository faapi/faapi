# 场景:路由开发

## 何时加载

用户要写 handler、定义接口、处理动态路由/catch-all/分组,或路由相关的问题。

## 路由文件约定

| 约定 | 说明 |
|------|------|
| 文件名 | `handler.ts`(固定) |
| 位置 | `src/api/<路径>/handler.ts`(固定在 src/ 下) |
| 导出 | HTTP 方法名(`GET`/`POST`/`PUT`/`DELETE`/`PATCH` 等) |
| URL | 由文件路径推导，`api/user/handler.ts` → `/api/user` |

路由源码目录固定为 `src/`，扫描 `src/api/**/*.ts`。

## URL 推导规则

```
文件路径:  api/user/handler.ts
路由路径:  /api/user  (文件路径去掉文件名)
URL:       /api/user
```

**路径映射示例**:

```
api/user/handler.ts              → /api/user
api/user/[id]/handler.ts         → /api/user/:id
api/user/[...slug]/handler.ts    → /api/user/*  (catch-all)
api/(auth)/login/handler.ts      → /api/login   (分组不影响 URL)
```

## 基本 handler

### GET 请求

```ts
// src/api/user/handler.ts
export interface Query {
  page: number;
  pageSize: number;
  name?: string;           // 可选字段
}

export function GET(query: Query) {
  return {
    page: query.page,
    pageSize: query.pageSize,
    name: query.name,
  };
}
```

**URL 参数都是 string**,但 faapi 通过 AST 类型校验自动转换:
- 声明 `page: number`,传入 `?page=1` → `query.page === 1`(number)
- 声明 `page: number`,传入 `?page=abc` → 返回 400
- 缺少必填字段 `?pageSize=10`(没有 page) → 返回 400

### POST 请求

```ts
export interface CreateUserBody {
  name: string;
  email: string;
  age?: number;
}

export function POST(body: CreateUserBody) {
  return { created: true, name: body.name };
}
```

请求体支持两种格式：

- **JSON**（默认）：`Content-Type: application/json`，handler 用 `body: Body` 接收，schema coerce=false（JSON 解析已是天然 JS 类型）。
- **form-urlencoded**：`Content-Type: application/x-www-form-urlencoded`，handler 用 `form: Form` 接收，schema coerce=true（form 值均为 string，number/boolean 字段自动转换，与 query/params 一致）。

`body` 与 `form` 互斥，handler 声明其一即可。

```ts
// JSON body
export interface CreateUserBody { name: string; age?: number; }
export function POST(body: CreateUserBody) {
  return { name: body.name, age: body.age };
}

// form-urlencoded
export interface LoginForm { username: string; remember?: boolean; }
export function POST(form: LoginForm) {
  // Content-Type: application/x-www-form-urlencoded
  // body: username=alice&remember=true
  // form.username === 'alice', form.remember === true
  return { user: form.username };
}
```

#### 不声明 `body`/`form` 时:框架不预读请求体

handler 不声明 `body`/`form` 参数时,框架**不会预读或解析请求体**(按参数名注入机制决定)。需要读取原始请求体的场景(如转发/代理、Webhook 验签、自定义协议解析),用标准 Web API 自行读取:

```ts
// 中转平台:读取原始 OpenAI 请求体透传给上游(不经 faapi schema 校验)
export async function POST(ctx) {
  const body = await ctx.request.json();   // 或 ctx.request.text() / .arrayBuffer()
  const upstream = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: ctx.headers.get('authorization')! },
    body: JSON.stringify(body),
  });
  return new Response(upstream.body, { status: upstream.status });
}
```

适用场景:
- **代理/转发**:透传任意请求体给上游,不校验
- **Webhook 验签**:需要原始字节做 HMAC 签名验证
- **自定义协议**:Content-Type 非 JSON/form 的请求体(如 protobuf)
- **大文件上传流式处理**:避免一次性 buffer 全部内容

### 动态路由参数

```ts
// src/api/user/[id]/handler.ts
export interface Params {
  id: string;
}

export function GET(params: Params) {
  return { id: params.id };
}
```

访问 `/api/user/123` → `params.id === '123'`。

### 多种参数混合

```ts
// src/api/user/[id]/handler.ts
export interface Query { includeDeleted?: boolean; }
export interface Params { id: string; }
export interface UpdateBody { name: string; }

export function GET(params: Params, query: Query) {
  // GET /api/user/123?includeDeleted=true
  return { id: params.id, includeDeleted: query.includeDeleted };
}

export function PUT(params: Params, body: UpdateBody) {
  // PUT /api/user/123, body: { name: 'new' }
  return { id: params.id, updated: body.name };
}
```

参数按**参数名**注入,不是按位置。`params`/`query`/`body` 是约定参数名。

## 内置注入参数

按参数名匹配,无需显式声明类型:

| 参数名 | 注入内容 | 示例 |
|--------|---------|------|
| `query` | URL 查询参数对象 | `GET(query: Query)` |
| `body` | 请求体(JSON) | `POST(body: Body)` |
| `form` | 表单请求体(`application/x-www-form-urlencoded`，coerce=true) | `POST(form: Form)` |
| `params` | 动态路由参数 | `GET(params: { id: string })` |
| `headers` | Headers 对象 | `GET(headers)` |
| `context` / `ctx` | 完整请求上下文 | `GET(ctx)` |
| `cookies` | Cookie 对象 | `GET(cookies)` |
| `ip` | 客户端 IP（X-Forwarded-For 优先） | `GET(ip)` |
| `files` | 上传文件数组 | `POST(files)` |
| `fields` | Multipart 表单字段 | `POST(fields)` |

自定义依赖(db、user 等)通过注入器注入,详见 [injection.md](./injection.md)。

## 返回值

### 对象 → 自动 JSON

```ts
export function GET() {
  return { ok: true };     // 自动 200 + application/json
}
```

### Response → 原样透传

```ts
export function GET() {
  return new Response('Not found', { status: 404 });
}
```

### ctx 便捷方法

```ts
export function GET(ctx) {
  return ctx.json({ error: 'Not found' }, 404);
  // return ctx.html('<h1>Hello</h1>');
  // return ctx.redirect('/login');
}
```

### SSE 流式

```ts
export function GET(ctx) {
  const sse = ctx.sse();
  sse.send({ data: 'chunk1' });
  setTimeout(() => sse.close(), 1000);
  return;  // 不返回普通值,SSE 与 ctx.json/html 互斥
}
```

详见 [realtime.md](./realtime.md)。

## 文件上传

```ts
// src/api/upload/handler.ts
export async function POST(files: File[], fields: Record<string, string>) {
  for (const file of files) {
    const buf = await file.arrayBuffer();
    // 处理文件
  }
  return { count: files.length, fields };
}
```

请求需用 multipart/form-data。

## 路由匹配规则

### 优先级

```
静态 > 动态 > catch-all
api/user/list/handler.ts    ← 静态,优先匹配
api/user/[id]/handler.ts   ← 动态
api/user/[...slug]/handler.ts  ← catch-all,最后
```

`GET /api/user/list` 匹配静态,`GET /api/user/123` 匹配动态。

### 分组(group)

```
api/(marketing)/about/handler.ts   → /api/about
api/(marketing)/contact/handler.ts → /api/contact
api/(auth)/login/handler.ts        → /api/login
```

分组只影响文件组织,不影响 URL。常用于同目录共享中间件。

### 方法不存在 → 405

```
api/user/handler.ts 只导出 GET
POST /api/user → 405 Method Not Allowed
```

### 路由不存在 → 404

```
GET /api/nonexistent → 404 Not Found
```

## 常见坑点

### 1. URL 参数是 string,声明 number 才自动转换

```ts
export interface Query {
  page: number;    // ?page=1 → 1 (number,自动转换)
  name: string;    // ?name=foo → 'foo' (string)
}
```

如果声明 `page: string`,值就是 `'1'`(string)。声明 `page: number` 才会转换 + 校验。

### 2. 可选字段必须加 `?`

```ts
export interface Query {
  page: number;       // 必填,缺失 → 400
  name?: string;      // 可选,缺失 → undefined
}
```

### 3. 类型校验失败不降级

AST 不支持的类型(如 `Promise`/`any`/`void`/`never`/`object`/`WeakMap`/`WeakSet`)直接抛 `SchemaExtractionError`,不降级为 `any`。

```ts
// ❌ 抛错:WeakMap 不支持
export interface Bad {
  data: WeakMap<string, number>;
}

// ✅ 用 Map<K,V> / Set<T> 或对象
export interface Good {
  data: Map<string, number>;
}
```

显式声明 `unknown` 表示不校验(任意值都通过):

```ts
export interface Anything {
  data: unknown;  // 不校验,任意值通过
}
```

### Map / Set 类型

`Map<K,V>` 与 `Set<T>` 已支持，但 JSON 序列化会丢失数据（`JSON.stringify(new Map())` 输出 `"{}"`），客户端必须按以下形式发送：

- **Map<K,V>**：entries 数组 `[["key", value], ...]`（与 `new Map(entries)` 兼容）
- **Set<T>**：普通数组 `[item, ...]`（与 `new Set(array)` 兼容）

```ts
// ✅ 支持:Map<K,V>
export interface POSTBody {
  data: Map<string, number>;
}
// 客户端发送 body: { "data": [["a", 1], ["b", 2]] }
// handler 收到的是 Map 实例:body.data.get('a') === 1

// ✅ 支持:Set<T>
export interface POSTBody {
  tags: Set<string>;
}
// 客户端发送 body: { "tags": ["a", "b", "c"] }
// handler 收到的是 Set 实例:body.tags.has('a') === true
```

注意：裸 `Map` / `Set`（无类型参数）和 `WeakMap` / `WeakSet` 仍然抛错。

### 4. handler 内部类型错误不会被 dev/build 捕获

```ts
export interface Query { page: number; }
export function GET(query: Query) {
  return query.unknownProp;  // dev/build 都不报错,运行时返回 undefined
}
```

dev 和 build 都用 esbuild 编译，只编译不检查类型。**需要用户自己跑** `pnpm typecheck`(`tsc --noEmit`)。

### 5. 跨文件类型引用

```ts
// types.ts
export interface User { id: number; name: string; }

// src/api/user/handler.ts
import type { User } from '../../types';  // Bundler 模式不写后缀

export function GET(): User {
  return { id: 1, name: 'foo' };
}
```

faapi 支持跨文件类型引用,dev 和 prod 都会合并所有文件的类型。

## 检查清单

- [ ] 文件名是 `handler.ts`
- [ ] 在 `api/` 下(CLI 默认)
- [ ] 导出 HTTP 方法名(`GET`/`POST` 等)
- [ ] 类型声明用 `interface` 或 `type alias` 均可
- [ ] 可选字段加 `?`
- [ ] 不用 `any`/`void`/`never`/`object`/`WeakMap`/`WeakSet`（用 `unknown` 表示不校验；`Map<K,V>`/`Set<T>` 已支持）
- [ ] 用 `Map<K,V>` / `Set<T>` 时客户端以 entries 数组 / 数组形式发送
- [ ] 返回对象或 Response
- [ ] `pnpm typecheck` 通过

## 相关场景

- [middleware.md](./middleware.md) — 在 handler 前后加鉴权/日志
- [injection.md](./injection.md) — 注入 db、user 等自定义依赖
- [config.md](./config.md) — 配置字段一览
- [response.md](./response.md) — `ok()` 辅助函数统一响应格式
- [debug.md](./debug.md) — 400/404/405 排查
