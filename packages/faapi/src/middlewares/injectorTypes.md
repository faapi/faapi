# injectorTypes

一句话概括：定义注入器的类型约定——`Injector` 函数类型和 `InjectorMap` 映射表类型。

## 为什么需要

faapi 的依赖注入机制需要统一的类型约定。注入器与中间件解耦：中间件管请求流程（鉴权、日志），注入器管提供依赖（数据库连接、用户对象）。`InjectorMap` 定义了"参数名 → 注入器函数"的映射关系，是用户在 `middlewares.ts` 中声明注入器的类型约束。

## 使用场景

- 用户在 `middlewares.ts` 中通过 `export const injectors: InjectorMap` 声明注入器
- 目录级注入器与全局注入器合并时，类型约束确保 key 与 handler 参数名一致
- 框架内部按 handler 参数名从 `InjectorMap` 查找并执行对应注入器

## 类型

| 类型 | 说明 |
|------|------|
| `Injector` | `(ctx: FaapiContext) => unknown \| Promise<unknown>` — 注入器函数，接收请求上下文，返回注入值 |
| `InjectorMap` | `Record<string, Injector>` — 参数名到注入器函数的映射表，key 必须与 handler 参数名一致 |

## 相关模块

- [middleware/middlewareTypes.ts](./middlewareTypes.ts) - 中间件类型定义
- [runtime/contextTypes.ts](../runtime/contextTypes.ts) - `FaapiContext` 类型定义
- [injection/resolveInjection.ts](../injection/resolveInjection.ts) - 运行时按参数名查找并执行注入器
