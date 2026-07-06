# 场景:统一响应格式与错误处理

## 何时加载

用户希望统一接口响应格式(如 `{ code, data, message }`)或自定义错误响应格式。

## 框架设计

框架不内置统一响应包装/错误格式化配置——它会切断 handler 返回类型与实际响应类型的关联,导致 TypeScript 类型失效、AST schema 与实际响应不一致。改为业务侧用两种模式实现:

| 模式 | 用途 | 类型一致性 |
|------|------|-----------|
| 辅助函数 `ok()`/`fail()` | 统一成功/失败响应结构 | ✅ handler 返回类型 = 实际响应类型 |
| 全局错误中间件 | 自定义错误响应 | 错误响应类型由中间件决定 |

## 辅助函数 — 统一响应包装(参考示例,非框架内置)

框架不内置 `ok`/`fail` 工具函数。业务方按需在项目中自定义(以下为参考实现,可自由调整包装结构):

```ts
// src/helpers/response.ts(用户自定义,非框架代码)
export interface ApiSuccess<T> {
  code: 0;
  data: T;
  message: 'success';
}

export interface ApiError {
  code: number;
  data: null;
  message: string;
}

/** 成功响应:ok({ name: 'foo' }) → { code: 0, data: { name: 'foo' }, message: 'success' } */
export function ok<T>(data: T): ApiSuccess<T> {
  return { code: 0, data, message: 'success' };
}

/** 失败响应(用于 handler 主动返回错误) */
export function fail(code: number, message: string): ApiError {
  return { code, data: null, message };
}
```

handler 中显式调用,返回类型与实际响应一致:

```ts
// api/user/handler.ts
import { ok } from '../helpers/response';

export interface User {
  id: string;
  name: string;
}

export function GET(): ApiSuccess<User> {
  return ok({ id: '1', name: 'foo' });
  // 返回类型 = ApiSuccess<User> = { code: 0, data: User, message: 'success' }
  // TypeScript 类型与实际响应完全一致,无类型断裂
}
```

## 全局中间件 — 自定义错误响应

在全局中间件中 `try/catch next()`,捕获 handler 抛错并返回自定义错误响应:

```ts
// faapi.config.ts
import type { FaapiMiddleware } from '@faapi/faapi';
import { ValidationError } from '@faapi/faapi';

const errorHandler: FaapiMiddleware = async (ctx, next) => {
  try {
    await next();
  } catch (err) {
    // 处理关心的错误,其余走框架兜底
    if (err instanceof ValidationError) {
      return ctx.json(
        { code: 422, message: err.message, issues: err.issues },
        422,
      );
    }
    const message = err instanceof Error ? err.message : 'Unknown error';
    const status = (err as { statusCode?: number })?.statusCode ?? 500;
    return ctx.json({ code: status, message }, status);
  }
};

export default {
  middlewares: [errorHandler],
};
```

## 错误兜底链

```
handler 抛错
  ↓
全局中间件 try/catch next() 拦截?  → 是 → 返回自定义错误响应
  ↓ 否
框架内置 formatErrorResponse 兜底
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
    ctx.json({ message: 'error' }, 500);  // 没有 return
  }
};

// ✅ 必须 return Response 才能拦截
const errorHandler: FaapiMiddleware = async (ctx, next) => {
  try {
    await next();
  } catch (err) {
    return ctx.json({ message: 'error' }, 500);
  }
};
```

### 2. 辅助函数未声明返回类型

```ts
// ❌ handler 返回类型被推断为 any,类型保护失效
export function GET() {
  return ok({ id: '1' });
}

// ✅ 显式声明返回类型,类型与实际响应一致
export function GET(): ApiSuccess<User> {
  return ok({ id: '1' });
}
```

### 3. 中间件包装破坏类型一致性

```ts
// ⚠️ 全局中间件包装 handler 返回值,handler 类型 ≠ 实际响应类型
const wrapResponse: FaapiMiddleware = async (ctx, next) => {
  await next();
  // 此模式下 TypeScript 无法感知包装结构,AST schema 也无法分析
};

// 推荐:用 ok() 辅助函数显式包装,保持类型一致
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
  return ctx.json({ message: 'error' }, 500);
}
```

## 检查清单

- [ ] 辅助函数 `ok()`/`fail()` 显式声明返回类型(如 `ApiSuccess<T>`)
- [ ] handler 显式标注返回类型,与实际响应结构一致
- [ ] 全局错误中间件 `try/catch next()` 后 `return ctx.json(...)` 拦截错误
- [ ] 中间件 `await next()` 不能漏掉 await
- [ ] 未处理的错误让框架内置 `formatErrorResponse` 兜底
- [ ] `pnpm typecheck` 通过

## 相关场景

- [middleware.md](./middleware.md) — 中间件洋葱模型、`try/catch next()` 错误捕获
- [config.md](./config.md) — `middlewares` 字段配置全局中间件
- [lifecycle.md](./lifecycle.md) — `onError` 副作用钩子(响应发出后触发)
- [route.md](./route.md) — handler 返回值类型注解
- [debug.md](./debug.md) — 400/500 错误排查
