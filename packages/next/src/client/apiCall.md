# apiCall

一句话概括：浏览器端统一请求入口——fetch 封装 + 非 JSON 响应守卫 + faapi 信封解包，失败一律抛结构化 `ApiError`。

## 为什么需要

faapi + Next.js 架构下，`/api/*` 由 faapi 处理（错误响应恒为 JSON 信封），但请求链路上的其他层会返回 HTML：反代/网关超时或重启时的错误页（502/504）、Next.js 的 404 页（URL 未命中 `/api` 前缀）、SSO 登录守卫的 302 重定向（fetch 默认跟随重定向，拿到登录页 HTML）。业务项目若直接 `res.json()`，HTML 会让解析器抛裸 `Unexpected token '<'` SyntaxError 直上 toast——用户看到无从下手的原文（TODO-faapi-gaps 记录的真实事故：单页 4 个请求 3 个裸 SyntaxError）。

apiCall 的职责是把这些「faapi 之外的世界」的异常响应**检测并转译**为可行动的结构化错误，同时保留排障现场。`谁期待 JSON，谁来守卫`——server 侧看不到这些字节，守卫只能在客户端做。

## 使用场景

- 客户端组件（`'use client'`）所有 API 请求统一走 `apiCall`，替代散落的裸 `fetch + res.json()` 手工解析
- 动作类报错 `catch (e)` 后按 frontend 约定 `toast.error(e.message)`——由 apiCall 保证 message 恒为可读文案

## 架构

```
fetch(input, init)                    // init 透传,不注入默认 headers
  → await res.text()
  → JSON.parse try/catch              // 守卫:覆盖 Content-Type 说谎的代理
  ├─ parse 失败(非 JSON)
  │   console.error 现场保留(status/url/body 前 200 字符)
  │   ├─ res.redirected → ApiError('REDIRECTED', ..., '登录状态已失效…')
  │   └─ 其他 → ApiError('NON_JSON_RESPONSE', ..., statusMessage(status))
  ├─ JSON 且 (!res.ok || body.error)
  │   → ApiError(body.error?.code ?? 'HTTP_ERROR', status,
  │              body.error?.message || statusMessage(status), body.error?.issues)
  ├─ JSON 且 res.ok 且 body.data === undefined
  │   → ApiError('EMPTY_RESPONSE', status, '请求失败: status')   // {data:null} 合法返回 null
  └─ 成功 → return body.data as T
```

### statusMessage 状态映射

| status | 文案 |
|---|---|
| 504 | 服务响应超时,请稍后重试 |
| 502 / 503 | 服务暂时不可用,请稍后重试 |
| 401 | 登录已过期,请刷新页面重新登录 |
| 其他 | `请求失败: ${status}` |

`statusMessage` 一并导出：业务方对文案有自定义需求（英文产品等）时可 fork apiCall 组合自己的映射，不改本模块。

## 决策记录

**`./client` 子路径 vs 独立 `@faapi/client` 包**：选 `./client` 子路径（维护者决策）。客户端代码不得传递性引入 `@faapi/faapi`（fs/child_process 会污染浏览器 bundle），子路径入口零 import 即可隔离，且免去新包的 npm 占位发布与 Trusted Publisher 配置成本。代价：业务方误用主入口 `@faapi/next` 会把服务端代码拉进客户端 bundle——Next build 显式报错而非静默，README 已显著警告。

**text + JSON.parse 守卫 vs Content-Type 头检测**：选前者（writer 项目实战验证的方案）。部分代理/服务在错误时仍返回 `application/json` 头，或正文与头不符；按 body 实际内容判定覆盖面最全，也避免双读 body。

**文案默认中文**：faapi 文档与两个参考项目（writer/llm）均为中文；英文产品方可 fork statusMessage。

## 已知限制

- **v1 仅支持默认信封**：解包逻辑按主包 `config.response` 默认实现（`{data}` / `{error:{message,...code?}}`）编写。业务方在 `faapi.config.ts` 自定义 `response.ok`/`response.fail` 时，需自行包装 apiCall（fork 后替换解包段），两处不允许各改各的。
- **不解析 HTML 内容**：各家错误页格式不同，提取信息脆弱；只检测 + 转译，现场（body 前 200 字符）留在 console 供排障。
- **`{}` 空对象视为错误**：主包对 `return undefined` 的响应序列化为 `{}`（无 data 字段），apiCall 抛 `EMPTY_RESPONSE`；声明返回 void 的 handler 不适用本客户端（用原生 fetch）。

## 相关模块

- [apiError.ts](./apiError.md) - 抛出的错误类型与信封类型
- 主包 responseFormatter.ts - 服务端信封契约权威定义
- 业务项目参考实现：writer `src/app/lib/request.ts`（守卫 + 状态映射的实战来源）、llm `src/app/lib/client-api.ts`（ApiError 结构来源；其裸 `res.json()` 即本模块修复的反面教材）
