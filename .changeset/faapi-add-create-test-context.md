---
"@faapi/faapi": major
---

新增 `@faapi/faapi/testing` 子路径，聚合所有测试 API 导出；新增 `createTestContext` 测试专用语法糖。

## 新增 `@faapi/faapi/testing` 子路径

测试 API 从主入口 `@faapi/faapi` 拆分到独立子路径 `@faapi/faapi/testing`，与生产代码导入分离：

```ts
// 之前
import { createTestContext, invokeHandler, createTestServer, connectWs } from '@faapi/faapi';

// 现在
import { createTestContext, invokeHandler, createTestServer, connectWs } from '@faapi/faapi/testing';
```

`@faapi/faapi/testing` 导出：
- 轻量测试：`createTestContext`、`invokeHandler`
- E2E 测试：`createTestServer`、`connectWs`、`MessageQueue`、`waitForWsOpen`
- 类型：`TestServer`、`TestServerOptions`、`WsTestClient`、`WsTestClientOptions`、`CreateTestContextOptions`、`FaapiContext`、`FaapiMiddleware`、`InjectorMap`

主入口 `@faapi/faapi` 不再导出测试 API（`createContext` 仍为公开运行时 API，供运行时同构场景使用）。

## 新增 `createTestContext` 测试专用语法糖

免去手写 `new Request('http://localhost/...')` 的样板代码：

```ts
import { createTestContext } from '@faapi/faapi/testing';

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

**设计要点**：

- `createContext(request, ...)` 签名不变，保持运行时与测试同构——运行时 `createServer` 也从真实 HTTP 请求构造 Request 调用它
- `createTestContext` 是纯测试便捷封装，内部构造 Request 调 `createContext`，不引入运行时分支
- **不接受 body 选项**：`createContext` 本身不读 `request.body`，body 注入由 `invokeHandler` 第 3 参数负责。POST/PUT/PATCH 测试时 body 单独传给 `invokeHandler`，避免在两处传 body 产生混淆
- query 支持 string/number/boolean 及数组（数组生成同名多值参数）

**效果对比**：

```ts
// 之前：手写完整 URL + 拼 query 字符串
const ctx = createContext(
  new Request('http://localhost/api/user?page=1&pageSize=10'),
  {},
  { db: { host: '...' } },
);

// 现在：对象形式，无样板代码
const ctx = createTestContext({
  path: '/api/user',
  query: { page: 1, pageSize: 10 },
  config: { db: { host: '...' } },
});
```

## 破坏性变更

测试 API（`createTestContext`、`invokeHandler`、`createTestServer`、`connectWs`、`MessageQueue`、`waitForWsOpen`）从主入口 `@faapi/faapi` 移除，改从 `@faapi/faapi/testing` 导入。业务方需将测试文件中的 import 路径从 `@faapi/faapi` 改为 `@faapi/faapi/testing`。

同步更新文档：AGENTS.md 5.10、`src/runtime/createContext.md`、`src/testing.md`、技能文档 `.trae/skills/faapi-dev/testing.md`；框架自身 5 个测试文件改用 `createTestContext`。
