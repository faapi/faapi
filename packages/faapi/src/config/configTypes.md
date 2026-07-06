# configTypes

一句话概括：定义框架配置 FaapiConfig 的类型结构。

## 为什么需要

CLI 和 server 启动时需要统一的配置结构，包含根目录、app 目录、端口和路由模式等。集中定义确保 CLI 解析和 server 启动使用相同的配置格式。

## 使用场景

- CLI 参数解析后生成 FaapiConfig
- server 启动时读取 FaapiConfig
- 扩展点：lifecycle（onReady/onClose/onError）、extendContext（扩展 ctx 方法）、cors（跨域配置）、helmet（安全头）、bodyLimit（请求体限制）、logger（结构化日志）、http2（HTTP/2 支持）、middlewares（全局中间件）、injectors（全局注入器）、plugins（应用级插件）

## 关键设计

- **统一响应格式**:不通过框架配置实现。推荐业务方在项目内自定义辅助函数 + 显式类型注解,保证 handler 返回类型 = 实际响应类型,避免类型断裂。详见"统一响应格式"章节。
- **错误处理**:handler 抛错 → 框架内置 `formatErrorResponse(err)` 兜底 → 仍失败则最简 500 JSON 响应 → 响应发出后触发 `onError` 副作用。业务方如需自定义错误响应,在全局中间件中 try/catch `next()` 即可。
- `lifecycle.onError(error, ctx)`:错误已被处理为响应、响应发出后触发的副作用钩子(参考 Fastify onError 语义)。用于日志/告警/链路追踪,**不修改已生成的响应**。自身抛错被捕获并忽略。
- `extendContext(ctx)`:创建上下文后调用,用户可挂载自定义方法/属性到 ctx;配合 `declare module '@faapi/faapi'` 增强 FaapiContext 类型。
- `FaapiContextConfig`:空 interface,用户可通过声明合并增强 `ctx.config` 的类型。

## 统一响应格式(参考模式,非框架内置)

框架不内置统一响应包装配置,也不内置 `ok`/`fail` 工具函数。业务方按需在项目中自定义辅助函数,保证 handler 返回类型 = 实际响应类型(以下为参考实现):

```ts
// src/utils/response.ts(用户自定义,非框架代码)
export function ok<T>(data: T) {
  return { code: 0, data, message: 'success' } as const;
}

export function fail(message: string, code = 1) {
  return { code, data: null, message } as const;
}

// api/user/handler.ts
import { ok, fail } from '../utils/response';

export interface User { id: number; name: string }

export function GET(): ReturnType<typeof ok<User>> {
  return ok({ id: 1, name: 'Alice' });
  // 实际响应: { code: 0, data: { id: 1, name: 'Alice' }, message: 'success' }
  // handler 类型签名 = 实际响应类型,TypeScript 类型保护完整
}
```

**为什么不内置统一响应包装配置**:
- 全局隐式包装是魔法,handler 返回类型 ≠ 实际响应类型,类型系统在响应边界失效
- AI/schema 静态分析无法感知外层包装结构
- 辅助函数模式显式、类型一致、可自由定制不同包装结构

**自定义错误响应**:用全局中间件捕获 handler 抛错:

```ts
// faapi.config.ts
import type { FaapiMiddleware } from '@faapi/faapi';

const errorHandler: FaapiMiddleware = async (ctx, next) => {
  try {
    await next();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = (err as any)?.statusCode ?? 500;
    ctx.json({ code: status, data: null, message }, status);
  }
};

export default {
  middlewares: [errorHandler],
} satisfies FaapiConfig;
```

## 相关模块

- `loadConfig.ts` - 运行时从 `faapi-config.js` 产物读取配置
- `compileConfig.ts` - 编译阶段合并 env 配置生成 `faapi-config.js`
- `createAppCore.ts` - 使用配置启动 server
- `createContext.ts` - 调用 extendContext 扩展 ctx
