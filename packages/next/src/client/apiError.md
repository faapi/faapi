# apiError

一句话概括：客户端统一错误类型——`ApiError`（携带 code/status/issues）与响应信封类型 `ApiEnvelope`，供 `apiCall` 抛出、业务方 `instanceof` 判定。

## 为什么需要

faapi 服务端错误响应是统一信封 `{ error: { code, message, issues? } }`（见主包 responseFormatter.ts 的 defaultFail / ValidationError 兜底），客户端需要对应的结构化错误类型承载这三层信息：

- `code`：字符串业务错误码（如 `'VALIDATION_ERROR'`），前端按 code 分支处理，不解析 message 字符串
- `status`：HTTP 状态码，用于上报/日志
- `issues`：`VALIDATION_ERROR` 时的字段级校验详情，前端回显到对应表单字段而非整体 toast

业务方 toast 直展 `e.message` 的前提是错误是 `instanceof Error`——`ApiError` 继承 Error，现有 `e instanceof Error ? e.message : String(e)` 消费代码不受影响。

## 使用场景

- `apiCall` 内部抛出（信封错误 / 非 JSON 响应 / 重定向 / 空响应）
- 业务方 `catch (e)` 后 `e instanceof ApiError` 按 `e.code` 分支（如 `AUTH_REQUIRED` 跳登录、`VALIDATION_ERROR` 回显 issues）

## 架构

```
响应信封（服务端契约,见主包 responseFormatter.ts）
  成功: { data: T }                        → ApiEnvelope<T>['data']
  失败: { error: { message, ...code? } }   → ApiEnvelope<T>['error']
  校验: { error: { code, message, issues } } → ApiError.issues（ApiValidationIssue[]）
```

`ApiValidationIssue` 镜像主包 `ValidationIssue`（path/code/expected/received/message，均必填 string）——服务端 JSON 的形状即客户端类型，**字段结构刻意保持一致但不 import 主包**（见下方零依赖约束）。

## 已知限制（零依赖约束，硬性）

本模块属于浏览器端代码（`@faapi/next/client` 子路径），**禁止 import `@faapi/faapi` 及任何 Node 模块**：

主包含 `node:fs` / `node:child_process` / `next/headers` 等服务端依赖，客户端组件若传递性引入，会把服务端代码拉进浏览器 bundle，导致 Next.js 客户端打包失败。业务项目曾因从 `@faapi/faapi` import 类型而踩坑（llm 项目 api-types.ts 注释记录了该教训），因此本目录所有类型独立声明，结构镜像而非引用。若主包 `ValidationIssue` 结构变更，此处需手动同步。

## 相关模块

- [apiCall.ts](./apiCall.md) - 唯一的抛出方
- 主包 responseFormatter.ts - 服务端信封契约的权威定义（`defaultOk`/`defaultFail`）
- 主包 errors/httpErrors.ts - `ValidationIssue` 结构的镜像来源
