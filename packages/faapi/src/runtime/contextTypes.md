# contextTypes

一句话概括：定义请求上下文 FaapiContext 及 ctx.config 类型（FaapiContextConfig）的结构。

## 为什么需要

运行时多个模块（createContext、resolveInput、invokeHandler、injectParams）都需要访问请求上下文。集中定义确保所有模块使用统一的上下文结构。FaapiContext 和 FaapiContextConfig 均为导出 interface，用户可通过 `declare module '@faapi/faapi'` 增强类型。

## 使用场景

- `createContext` 创建 FaapiContext 实例
- `resolveInput` 从 FaapiContext 提取输入
- `invokeHandler` 将 FaapiContext 传给 handler
- `injectParams` 从 FaapiContext 注入参数
- handler 通过 `ctx.setETag(value)` 设置 ETag 响应头（框架不自动做 304 协商缓存，由业务方自行判断）
- 用户 `declare module '@faapi/faapi'` 增强 FaapiContext（自定义方法）或 FaapiContextConfig（ctx.config 类型）

## ctx.ok / ctx.fail

FaapiContext 新增两个响应便捷方法（与 `ctx.json`/`ctx.html`/`ctx.redirect` 同级），配合 `invokeHandler` 的 `wrapResult` 自动包裹实现统一响应格式：

| 方法 | 签名 | 说明 |
| --- | --- | --- |
| `ctx.ok(data)` | `(data: unknown) => Response` | 显式包裹成功响应。用 `config.response.ok`（默认 `(data) => ({ data })`）包裹 data 并返回 JSON Response。等价于 handler 直接 `return data`（框架在 `toResponse` 前自动包裹），但显式调用语义更清晰。返回的是 Response 对象，不会被 `wrapResult` 再次包裹（避免双重包裹）。 |
| `ctx.fail(options)` | `(options: FailOptions) => Response` | 返回错误响应。`options` 为对象形式 `{ status?, code?, message }`：`status` 可选（省略时默认 500）；`code` 可选（省略时响应 body 里不含 code 字段）；`message` 必填。status 和 code 是两个独立维度，无推导关系。body 用 `config.response.fail`（默认只把非 undefined 的字段放入 error 对象）包装。 |

```ts
// 等价写法（假设 response.ok 为默认实现）：
export function GET() {
  return { id: 1 };              // 自动包裹 → { data: { id: 1 } }
}
export function GET2(ctx) {
  return ctx.ok({ id: 1 });      // 显式包裹 → { data: { id: 1 } }
}

// 错误响应：
return ctx.fail({ message: '出错' });                                   // HTTP 500, { error: { message: '出错' } }
return ctx.fail({ status: 404, message: '用户不存在' });                 // HTTP 404, { error: { message: '用户不存在' } }
return ctx.fail({ status: 404, code: 'USER_NOT_FOUND', message: '用户不存在' }); // HTTP 404, { error: { code: 'USER_NOT_FOUND', message: '用户不存在' } }
```

`FailOptions` 为本模块导出的 interface（`{ status?: number; code?: string; message: string }`），用户可直接引用做参数类型约束。

## 相关模块

- `createContext.ts` - 创建 FaapiContext 实例
- `resolveInput.ts` - 从上下文提取输入
- `invokeHandler.ts` - 使用上下文调用 handler
