# 场景:调试与错误排查

## 何时加载

dev 启动失败、路由不生效、类型校验 400、500 错误、行为与预期不符。

## 错误状态码速查

| 状态码 | 原因 | 排查方向 |
|--------|------|---------|
| 400 | query/body/params 缺失或非法 | 类型校验失败 |
| 404 | 路由不存在 | 文件位置/路径映射 |
| 405 | 方法不允许 | handler 导出的方法 |
| 500 | 模块加载失败/handler 异常 | 服务端日志 |

## 400 — 类型校验失败

### 现象

```json
{ "error": "Validation failed: page expected number, got string" }
```

### 原因

- 必填字段缺失:`?page=` 缺少 page
- 类型不匹配:`?page=abc` 但声明 `page: number`
- 嵌套对象字段缺失
- 数组元素类型错误

### 排查

1. **检查 interface 声明**

```ts
export interface Query {
  page: number;       // 必填,?page= 必须提供
  name?: string;      // 可选,加 ?
}
```

2. **检查请求参数**

```bash
curl 'http://localhost:3000/api/user?page=1&pageSize=10'
# 不要用 page=abc
```

3. **URL 参数是 string,声明 number 才自动转换**

`?page=1` → string `'1'` → faapi 自动转 number `1`。声明 `page: string` 则保持 `'1'`。

### AST 不支持的类型

直接抛 `SchemaExtractionError`,不降级:

```ts
// ❌ Map/Set/Promise 不支持
export interface Bad {
  data: Map<string, number>;
}

// ❌ any/void/never/object 抛错
export interface Bad {
  data: any;
}

// ✅ 用对象/数组
export interface Good {
  data: Record<string, number>;
}

// ✅ unknown 表示不校验
export interface Anything {
  data: unknown;
}
```

## 404 — 路由不存在

### 原因

1. 文件位置不对
2. 路径映射错误
3. dev 模式未扫描到文件

### 排查

1. **检查文件位置**

```
❌ api/user/handler.ts      ← appDir 默认是 src，扫描 src/api/ 不是 api/
❌ app/user/handler.ts          ← 必须在 api/ 下
✅ src/api/user/handler.ts
```

2. **检查 URL**

```
api/user/handler.ts → /api/user(不是 /user)
api/user/[id]/handler.ts → /api/user/123
```

3. **检查启动参数**

```bash
faapi --app-dir .      # 如果路由在根目录 api/
faapi api/auth/*          # 只扫描 auth 下的路由
```

4. **查看启动日志**

```
- Routes: 3 route(s), 1 WS route(s)
  - GET  /api/user
  - POST /api/user
  - GET  /api/user/:id
```

如果路由数 0,说明没扫描到文件。

## 405 — 方法不允许

### 原因

handler 文件存在,但没导出对应的 HTTP 方法。

### 排查

```ts
// src/api/user/handler.ts

// 只导出了 GET
export function GET() { ... }

// POST /api/user → 405
// DELETE /api/user → 405
```

需要支持哪些方法就导出哪些:`GET`/`POST`/`PUT`/`DELETE`/`PATCH`。

## 500 — 服务端错误

### 原因

1. handler 抛错
2. 模块加载失败
3. 注入器抛错

### 排查

1. **查看服务端日志**(终端输出)

```
- Error: Cannot find module '../../utils/db'
```

2. **handler 异常**

```ts
export function GET(ctx) {
  throw new Error('boom');  // 500
}
```

配置 `errorFormat` 自定义错误响应,配置 `lifecycle.onError` 记录日志:

```ts
export default {
  errorFormat(err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  },
  lifecycle: {
    onError(error, ctx) {
      console.error(`[onError] ${ctx.method} ${ctx.path}`, error);
    },
  },
};
```

## dev 启动失败

### 1. 端口被占

```
Error: listen EADDRINUSE: address already in use :::3000
```

**解决**:`faapi --port 3001` 或杀掉占用进程。

### 2. 配置文件语法错误

```
Error loading config: Unexpected token }
```

**解决**:检查 `faapi.config.ts` 语法。

### 3. 路由扫描失败

```
- Routes: 0 route(s)
```

**原因**:
- `api/` 下没有 `handler.ts`
- patterns 不匹配
- appDir 配置错误

**解决**:检查文件位置和启动参数。

### 4. 模块加载失败

```
Error: Cannot find module './handler'
```

**原因**:tsconfig 配置为 `moduleResolution: Bundler`,但运行时用了不支持无后缀解析的工具(如直接 `node dist/index.js` 而未经过 tsup 打包)。

**解决**:本地相对导入路径不写后缀,由 tsc/tsx/tsup 解析。

```ts
// ✅ 正确:无后缀
import { foo } from './utils';

// ❌ 错误:写 .js 后缀
import { foo } from './utils.js';

// ❌ 错误:写 .ts 后缀
import { foo } from './utils.ts';
```

> 注:dev 模式 tsx 支持 Bundler 解析。prod 模式由 tsup 打包成单文件,无相对路径问题。

## prod 启动失败

### 1. dist/faapi-routes.js 或 dist/faapi-schema.js 不存在

```
[faapi] dist/faapi-routes.js 或 dist/faapi-schema.js 不存在,请先执行 `faapi build` 构建生产产物。
```

**原因**:没跑 `faapi build` 就用 `faapi start` 启动。

**解决**:

```bash
faapi build
faapi start
```

### 2. 路由文件未编译

```
Error: Cannot find module 'dist/api/user/handler.js'
```

**原因**:`faapi build` 没编译路由文件,或 patterns 不匹配。

**解决**:

```bash
faapi build  # 重新编译
```

## watch 模式问题

### 1. 文件变化没触发重建

**原因**:
- 文件不在 watch patterns 内
- 文件在 `node_modules`/`dist` 等忽略目录

**解决**:检查 `src/api/**/*.ts` 是否匹配,文件是否在忽略目录。

### 2. 重建报错

```
- Error rebuilding routes: ...
```

**原因**:handler 文件语法错误或导入错误。

**解决**:查看错误信息,修复后保存,watch 会自动重试。

## 类型校验不生效

### 现象

handler 参数类型声明了,但请求传错参数也不报 400。

### 原因

1. 参数名不是内置注入名(`query`/`body`/`params` 等)
2. 类型声明在函数外部,handler 没用
3. 用了 AST 不支持的类型(降级为不校验)

### 排查

```ts
// ❌ 参数名不对
export function GET(searchQuery: Query) { ... }
// searchQuery 不是内置注入名,不会校验

// ✅ 用 query
export function GET(query: Query) { ... }
```

```ts
// ❌ 类型声明在外部,handler 没引用
interface Query { page: number; }
export function GET(query: any) { ... }  // query 是 any,不校验
```

## dev 不报类型错误

### 现象

```ts
export interface Query { page: number; }
export function GET(query: Query) {
  return query.unknownProp;  // dev 不报错,运行时 undefined
}
```

### 原因

faapi 用 tsx 转译,**只转译不检查类型**。框架不主动跑 tsc。

### 解决

用户自己跑 `pnpm typecheck`:

```bash
pnpm typecheck  # tsc --noEmit
```

或者依赖 IDE 实时检查(VSCode/WebStorm 写代码时就会标红)。

详见 [SKILL.md](./SKILL.md) 的"设计原则"部分。

## 跨文件类型引用问题

### 现象

handler 引用了其他文件的类型,dev 模式校验不生效。

### 原因

dev 模式 watch 是全量重建,跨文件类型引用应该自然解决。如果还有问题:

1. 类型导出方式不对(用 `export interface` 不是 `export type`)
2. 循环引用

### 排查

```ts
// ✅ 正确:Bundler 模式无后缀
import type { User } from '../../types';

// ❌ 错误:写 .js 或 .ts 后缀
import type { User } from '../../types.js';
import type { User } from '../../types.ts';
```

## 检查清单

### 启动问题
- [ ] `api/` 下有 `handler.ts`
- [ ] `faapi` 命令在项目根目录运行
- [ ] `pnpm typecheck` 通过
- [ ] `pnpm build` 成功(prod 模式)
- [ ] 端口未被占用

### 路由问题
- [ ] 文件位置正确(`api/<路径>/handler.ts`)
- [ ] 导出 HTTP 方法名
- [ ] URL 包含 `/api/` 前缀
- [ ] 启动日志显示路由数 > 0

### 类型校验问题
- [ ] 参数名是内置注入名(`query`/`body`/`params`)
- [ ] 类型用 `interface` 声明
- [ ] 可选字段加 `?`
- [ ] 不用 `Map`/`Set`/`any` 等 AST 不支持的类型

### 错误处理
- [ ] 配置 `errorFormat` 自定义错误响应
- [ ] 配置 `lifecycle.onError` 记录日志
- [ ] 查看终端服务端日志

## 相关场景

- [init.md](./init.md) — 项目结构、CLI 参数
- [route.md](./route.md) — 路由约定、类型校验
- [config.md](./config.md) — errorFormat、onError
