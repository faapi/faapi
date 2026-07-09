# 场景:依赖注入

## 何时加载

用户要注入 db、user、redis 等自定义依赖,或理解注入器机制。

## 注入机制

faapi 按**参数名**注入依赖,不是按类型。两种注入源:

1. **内置注入**:`query`/`body`/`params`/`headers`/`ctx`/`cookies`/`files`/`fields`(框架自动)
2. **注入器注入**:`injectors` 配置提供的自定义依赖(db、user 等)

**参数名匹配**:handler 参数名必须与注入源一致,与参数顺序无关。

```
GET(query: Query, db: Db)
    ↑ 自动注入     ↑ injectors.db 注入
```

## 内置注入参数

| 参数名 | 注入内容 | 示例 |
|--------|---------|------|
| `query` | URL 查询参数对象 | `GET(query: Query)` |
| `body` | 请求体(JSON) | `POST(body: CreateUserBody)` |
| `form` | 表单请求体(`application/x-www-form-urlencoded`，`Record<string, string>`，coerce=true) | `POST(form: LoginForm)` |
| `params` | 动态路由参数 | `GET(params: { id: string })` |
| `headers` | 请求头 Headers 对象 | `GET(headers)` |
| `context` / `ctx` | 完整请求上下文 | `GET(ctx)` |
| `cookies` | Cookie 对象 | `GET(cookies)` |
| `ip` | 客户端 IP（X-Forwarded-For 优先） | `GET(ip)` |
| `files` | 上传文件数组 | `POST(files)` |
| `fields` | Multipart 表单字段 | `POST(fields)` |

**`form` 与 `body` 互斥**：handler 声明其一即可。`form` 适用于 `Content-Type: application/x-www-form-urlencoded` 的请求体，框架按 URL 表单解析为 `Record<string, string>`，schema 校验时 coerce=true（与 query/params 一致，number/boolean 字段自动转换字符串）。`body` 适用于 JSON 请求体，coerce=false。

```ts
// src/api/login/handler.ts
export interface LoginForm {
  username: string;
  password: string;
  remember?: boolean;  // "true" / "false" 自动转 boolean
}

export function POST(form: LoginForm) {
  // form.username: string
  // form.remember: boolean | undefined
  return { user: form.username };
}
```

**POST/PUT/PATCH 始终预读请求体**:faapi 对这些方法无条件调用 `resolveInput` 解析请求体(无论 handler 是否声明 `body`/`form`)。声明 `body` 参数获取已解析并校验的对象;不声明时请求体也已被消费,**不能用 `ctx.request.json()` / `.text()`**(会抛 "Body has already been read")。代理转发场景应声明 `body` 参数(可用 index signature 允许开放字段),详见 [route.md](./route.md) 的"POST/PUT/PATCH 的请求体注入"章节。

**自定义业务配置**通过 `ctx.config` 访问,不作为参数名注入:

```ts
// faapi.config.ts
export default {
  db: { host: 'localhost', port: 5432 },
};

// src/api/user/handler.ts
export function GET(ctx) {
  return { dbHost: ctx.config.db.host };
}
```

## 注入器配置

注入器位于 `middlewares.ts` 的命名导出 `injectors`,或 `faapi.config.ts` 的 `injectors` 字段。

### 目录级注入器

```ts
// src/api/admin/middlewares.ts
import type { FaapiMiddleware, InjectorMap } from '@faapi/faapi';

export default [
  async (ctx, next) => {
    ctx.user = await getUserFromToken(ctx.headers.get('authorization'));
    await next();
  },
] satisfies FaapiMiddleware[];

export const injectors: InjectorMap = {
  db: () => getDbConnection(),
  user: (ctx) => ctx.user,  // 取中间件塞的值
  redis: () => getRedisClient(),
};
```

### 全局注入器

```ts
// faapi.config.ts
export default {
  injectors: {
    db: () => getDbConnection(),
    redis: () => getRedisClient(),
  },
};
```

**覆盖规则**:目录注入器覆盖同名全局注入器。详见 [config.md](./config.md)。

## handler 接收注入

```ts
// src/api/admin/handler.ts
export function GET(db: Db, user: User) {
  //  db ← injectors.db()
  //  user ← injectors.user(ctx)
  return { userId: user.id, dbHost: db.host };
}
```

参数名必须与 injectors 的 key 一致,与顺序无关。

## 注入器签名

```ts
type Injector = (ctx: FaapiContext) => unknown | Promise<unknown>;
type InjectorMap = Record<string, Injector>;
```

- 同步:`db: () => getDb()`
- 异步:`user: async (ctx) => await getUser(ctx.headers.get('token'))`
- 读 ctx:`user: (ctx) => ctx.user`

## 示例:数据库注入

```ts
// src/api/db/middlewares.ts
import type { InjectorMap } from '@faapi/faapi';
import { createConnection } from 'mysql2/promise';

let connection: any;

export const injectors: InjectorMap = {
  db: () => {
    if (!connection) {
      connection = createConnection({ host: 'localhost', user: 'root' });
    }
    return connection;
  },
};
```

```ts
// src/api/users/handler.ts
export interface Db {
  query: (sql: string) => Promise<any[]>;
}

export async function GET(db: Db) {
  const users = await db.query('SELECT * FROM users');
  return { users };
}
```

## 示例:从 ctx 取值

中间件塞值到 ctx,注入器读 ctx:

```ts
// src/api/middlewares.ts
export default [
  async (ctx, next) => {
    const token = ctx.headers.get('authorization');
    if (token) {
      ctx.user = await verifyToken(token);  // 塞值
    }
    await next();
  },
] satisfies FaapiMiddleware[];

export const injectors: InjectorMap = {
  user: (ctx) => ctx.user,  // 读中间件塞的值
};
```

```ts
// src/api/me/handler.ts
export interface User { id: number; name: string; }

export function GET(user: User) {
  return user;  // 来自 injectors.user(ctx)
}
```

## 全局注入器 vs 目录注入器

```ts
// faapi.config.ts(全局)
export default {
  injectors: {
    db: () => globalDb(),
  },
};

// src/api/special/middlewares.ts(目录)
export const injectors: InjectorMap = {
  db: () => specialDb(),  // 覆盖全局 db
  cache: () => getCache(),
};
```

`api/special/` 下的路由用 `specialDb()`,其他路由用 `globalDb()`。

## 常见坑点

### 1. 参数名不匹配

```ts
// injectors: { db: ... }

// ❌ 参数名是 database,不匹配
export function GET(database: Db) { ... }

// ✅ 参数名是 db
export function GET(db: Db) { ... }
```

### 2. 注入器抛错未处理

```ts
// ❌ 抛错会变成 500
export const injectors: InjectorMap = {
  db: () => {
    throw new Error('connection failed');
  },
};
```

注入器抛错会被框架捕获,返回 500。如果需要自定义错误,在注入器内 try/catch。

### 3. 以为 config 会作为参数注入

```ts
// ❌ config 不是参数名注入
export function GET(config: any) { ... }

// ✅ 通过 ctx.config 访问
export function GET(ctx) {
  return { dbHost: ctx.config.db.host };
}
```

### 4. 注入器每次调用都执行

注入器是按需调用的,handler 有该参数才执行 injectors[key]()。如果性能敏感,注入器内部做缓存。

## 检查清单

- [ ] `middlewares.ts` 导出 `injectors: InjectorMap`
- [ ] handler 参数名与 injectors key 一致
- [ ] 异步注入器返回 Promise
- [ ] 自定义类型声明(可选,增强 IDE 提示)
- [ ] `pnpm typecheck` 通过

## 相关场景

- [middleware.md](./middleware.md) — 中间件塞值到 ctx
- [config.md](./config.md) — 全局注入器、ctx.config
- [route.md](./route.md) — handler 参数注入
