# createContext

一句话概括：从 Request 创建请求上下文。

## 为什么需要

将 Web 标准 Request 对象转换为 faapi 上下文，提取 params、query、headers 等信息。

## 使用场景

- 请求处理时创建上下文
- 提取请求相关信息（含内联读取 `user-agent` 请求头存到 `ctx.ua`；`ctx.ip` 由调用方从 `IncomingMessage` 提取后传入）
- 执行 config.extendContext 扩展钩子（用户可挂载自定义 ctx 方法）

## ctx.ok / ctx.fail 挂载

createContext 在创建 ctx 时挂载 `ok` 和 `fail` 两个响应方法（与 `json`/`html`/`redirect` 同级），均返回 Response 对象，`invokeHandler` 的 `wrapResult` 不会再次包裹：

- `ctx.ok(data)`：从 `config.response.ok` 读取包装函数（默认 `(data) => ({ data })`），包裹 data 后调 `ctx.json(body)` 返回 JSON Response（status 200）。
- `ctx.fail(options)`：从 `config.response.fail` 读取包装函数（默认只把非 undefined 的字段放入 error 对象，即 `{ error: { message, ...code? } }`）；`options.status` 省略时 HTTP 状态码默认 500；`options.code` 省略时不传入 fail 函数（默认实现则不放入 error 对象）；最终调 `ctx.json(body, options.status ?? 500)` 返回错误 Response。status 和 code 是两个独立维度，无推导关系。

```ts
// 默认配置下的行为：
ctx.ok({ id: 1 });
// → ctx.json({ data: { id: 1 } }) → 200

ctx.fail({ status: 404, message: '用户不存在' });
// → ctx.json({ error: { message: '用户不存在' } }, 404)  (无 code 字段)

ctx.fail({ status: 404, code: 'USER_NOT_FOUND', message: '用户不存在' });
// → ctx.json({ error: { code: 'USER_NOT_FOUND', message: '用户不存在' } }, 404)

ctx.fail({ message: '出错' });
// → ctx.json({ error: { message: '出错' } }, 500)  (status 默认 500,无 code 字段)
```

两个函数均从 `ctx.config.response` 读取配置，未配置时使用框架默认实现（见 `configTypes.ts` 的 `ResponseConfig`）。

## 相关模块

- `contextTypes.ts` - 类型定义
- `invokeHandler.ts` - 使用上下文
- `configTypes.ts` - extendContext 钩子定义
