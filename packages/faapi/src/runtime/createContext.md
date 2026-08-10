# createContext

一句话概括：从 Request 创建请求上下文；另导出 `createTestContext` 作为测试专用语法糖（接受选项对象，内部构造 Request）。

## 为什么需要

将 Web 标准 Request 对象转换为 faapi 上下文，提取 params、query、headers 等信息。

`createContext(request, params, config?, ip?)` 是运行时与测试共用的同构入口——运行时 `createServer` 从真实 `IncomingMessage` 构造 Request 调用，测试时业务方也可直接调用。`createTestContext(options)` 是测试专用便捷封装，接受 `{ method?, path, query?, headers?, params?, config?, ip? }` 对象，内部构造 Request 调 `createContext`，免去手写 `new Request('http://localhost/...')` 的样板代码（无意义 host、query 拼接 URL、headers 构造）。

## 使用场景

- 请求处理时创建上下文（`createContext`，运行时 + 测试同构）
- 测试时便捷创建上下文（`createTestContext`，纯测试语法糖）
- 提取请求相关信息（含内联读取 `user-agent` 请求头存到 `ctx.ua`；`ctx.ip` 由调用方从 `IncomingMessage` 提取后传入）
- 执行 config.extendContext 扩展钩子（用户可挂载自定义 ctx 方法）

## createTestContext

```ts
import { createTestContext } from '@faapi/faapi';

const ctx = createTestContext({
  method: 'POST',                              // 默认 'GET'
  path: '/api/user',                            // 必填，无需写 host
  query: { page: 1, tags: ['a', 'b'] },        // 对象形式，自动拼接 URL（数组生成同名多值参数）
  headers: { authorization: 'Bearer xxx' },    // 请求头对象
  params: { id: '123' },                        // 动态路由参数，默认 {}
  config: { db: { host: '...' } },              // 业务配置，默认 {}
  ip: '1.2.3.4',                                // 客户端 IP，默认 ''
});
```

**body 不在此处理**：`createContext` 本身不读 `request.body`，body 注入由 `invokeHandler` 的第 3 个参数负责。POST/PUT/PATCH 测试时 body 单独传给 `invokeHandler`，避免在两处传 body 产生混淆。

**为什么不合并进 createContext**：`createContext` 保持 `(request: Request)` 签名使运行时与测试同构；`createTestContext` 是纯测试便捷封装，不引入运行时分支。

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
