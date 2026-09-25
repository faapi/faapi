# @faapi/next 集成浏览器端请求层（./client 子路径）

## Context

业务项目（llm）的 apiCall 直接 `res.json()`，外部 HTML 响应（反代错误页 / Next 404 页 / SSO 登录页重定向）以裸 `Unexpected token '<'` SyntaxError 直上 toast；writer 项目已手写变通（`text()` → `JSON.parse` 守卫 + 状态中文映射）。缺口已记录在 [TODO-faapi-gaps.md](../../../TODO-faapi-gaps.md)。本次将其下沉为框架能力。

**形态决策（用户已拍板）**：不新建 `@faapi/client` 子包，集成进 `@faapi/next`，通过独立 `./client` 子路径导出。关键架构约束（来自 llm/src/app/lib/api-types.ts 的教训）：客户端代码**不得传递性引入** `@faapi/faapi`（含 fs/child_process，会导致 Next 客户端打包失败）——`./client` 入口文件零 import 即可隔离，客户端组件必须 `import { apiCall } from '@faapi/next/client'`（误用主入口会拉入服务端代码，Next build 显式报错，非静默）。

**参考实现**：
- writer [request.ts](/Users/tu/workspace/cnb/writer/src/app/lib/request.ts)：text→JSON.parse 守卫 + statusMessage 中文映射（504→'服务响应超时,请稍后重试'、502/503→'服务暂时不可用,请稍后重试'、401→'登录已过期,请刷新页面重新登录'、兜底→`请求失败: ${status}`）
- llm [api-types.ts](/Users/tu/workspace/cnb/llm/src/app/lib/api-types.ts)：ApiError（code/status/message，extends Error，name='ApiError'）

**envelope 契约**（主包 responseFormatter.ts 已核实）：成功 `{data}`；失败 `{error: {message, ...code?}}`；ValidationError 附 `issues: {path, code, expected, received, message}[]`。

## 实现步骤（DDD：每模块文档→测试→代码）

### 1. packages/next/src/client/apiError 三件套

- **apiError.ts**：`ApiError extends Error`（readonly `code: string`、`status: number`、`issues?: readonly ApiValidationIssue[]`，构造签名 `(code, status, message, issues?)`，name='ApiError'）；`ApiValidationIssue { path: string; code: string; expected?: unknown; received?: unknown; message: string }`（镜像主包 ValidationIssue 结构，**不 import 主包**）；`ApiEnvelope<T> = Partial<{data: T}> & Partial<{error: {code?: string; message: string; issues?: ApiValidationIssue[]}}>`
- **apiError.test.ts**：`instanceof Error` / `name === 'ApiError'` / code、status 只读字段 / 可选 issues 挂载
- **apiError.md**：格式照 [createNextServer.md](../../../packages/next/src/createNextServer.md)（一句话概括/为什么需要/使用场景/架构/已知限制/相关模块）；**必须记录**零依赖约束：不得 import `@faapi/faapi`（fs/child_process 传递性污染客户端打包）

### 2. packages/next/src/client/apiCall 三件套

- **apiCall.ts** 行为规格：
  1. `await fetch(input, init)`——init 透传，不注入默认 headers
  2. `const text = await res.text()` 后 `JSON.parse` try/catch（覆盖 Content-Type 说谎的代理）
  3. parse 失败（非 JSON）→ `console.error('[apiCall] 非 JSON 响应', { status: res.status, url: res.url, body: text.slice(0, 200) })` 保留现场，然后抛 ApiError：
     - `res.redirected === true` → `ApiError('REDIRECTED', status, '登录状态已失效，请刷新页面重新登录')`
     - 其他 → `ApiError('NON_JSON_RESPONSE', status, statusMessage(status))`
  4. JSON 且 `!res.ok || body.error` → `ApiError(body.error?.code ?? 'HTTP_ERROR', res.status, body.error?.message || statusMessage(res.status), body.error?.issues)`（body.error 优先于 res.ok）
  5. JSON 且 res.ok 且 `body.data === undefined` → `ApiError('EMPTY_RESPONSE', res.status, '请求失败: ' + res.status)`（`{data: null}` 合法返回 null，不误伤）
  6. 成功 → `return body.data as T`
- **statusMessage(status)**：writer 中文映射（上文），一并导出供业务方 fork 自定义文案
- **apiCall.test.ts**（`vi.stubGlobal('fetch', ...)`，Node 24 原生 Response；`redirected` 是只读属性，该用例用普通对象 stub）14 用例：成功解包 / `{data:null}` 返回 null / HTML 502、404、504、401 中文文案 / redirected→REDIRECTED / console.error 现场断言（spyOn）/ 空 body / JSON 500 透传 code·status·message / JSON 200 带 error / `{}` 无 data→EMPTY_RESPONSE / VALIDATION_ERROR issues 挂载 / fetch 网络错误原样上抛（非 ApiError）
- **apiCall.md**：记录缺口场景、writer 方案出处、决策记录（./client 子路径 vs 独立包：选前者，用户决策）、已知限制（v1 仅支持默认信封，`config.response.ok/fail` 自定义时业务方自行包装；文案默认中文，可 fork statusMessage）

### 3. packages/next/src/client/index.ts

`export { apiCall, statusMessage, ApiError }` + `export type { ApiEnvelope, ApiValidationIssue }`

### 4. packages/next/package.json（[现文件](../../../packages/next/package.json)）

- `exports` 加：`"./client": { "types": "./src/client/index.ts", "import": "./src/client/index.ts" }`
- `publishConfig.exports` 加：`"./client": { "types": "./dist/client/index.d.ts", "import": "./dist/client/index.js" }`

### 5. packages/next/tsup.config.ts

`entry: ['src/index.ts', 'src/client/index.ts']`（tsup 多入口保留目录结构 → dist/client/index.js）；platform/external 不动（client 文件零 import，platform 'node' 无影响）

### 6. .changeset/next-client-api.md（新建）

frontmatter `"@faapi/next": minor`；正文：新增 `@faapi/next/client` 浏览器端请求层 apiCall + ApiError，非 JSON 响应（反代错误页/SSO 登录页重定向）转译为结构化中文错误，不再裸抛 SyntaxError

### 7. packages/next/README.md

新增 `./client` 章节：用法示例 + **显著警告**：客户端组件必须用 `@faapi/next/client` 子路径导入，主入口是服务端代码（import 会污染客户端 bundle 导致 build 失败）

### 8. 收尾

- 验证全绿后删除 [TODO-faapi-gaps.md](../../../TODO-faapi-gaps.md)（仅此一条目；debug.md 流程：修复合并后删除）
- AGENTS.md 确认无需更新：5.2 包结构清单本就未列 next/agent（先例一致），无新包流程触发

## 已确认无需改动

pnpm-workspace / eslint / ci.yml / release.yml（递归自动覆盖）；fixed 数组与 peerDeps（next 已在册，client 子路径零依赖）；tsconfig.json / tsconfig.test.json（`include: ["src"]` 自动覆盖新文件，base 默认含 DOM lib 提供 fetch/RequestInit 类型）；vitest.config.ts（`include: src/**/*.test.ts` 自动覆盖，client 测试相对导入不涉 alias）

## 验证

1. `pnpm --filter @faapi/next test` —— 新增 apiCall/apiError 用例全绿
2. `pnpm -r run typecheck` + `pnpm -r run typecheck:test` + `pnpm -r run lint` + `pnpm -r run test` + `pnpm -r run build` 全过
3. 构建产物断言：`dist/client/index.js` 存在且**零 import 语句**（grep 验证，证明客户端零传递依赖）；`dist/client/index.d.ts` 存在
4. Node 24 加载冒烟：`node -e "import('./packages/next/dist/client/index.js').then(m => console.log(Object.keys(m)))"`

## 范围外（明确不做）

- writer/llm 业务项目迁移到 `@faapi/next/client`：待本变更随正式发版上 npm 后由业务项目自行进行
- 个人技能库 frontend-error.md 同步：按 AGENTS.md 约定，发版后由维护者手动触发
- npm 发版：changeset 就位即可，下次正式发版自动带出 minor，不在本次执行
