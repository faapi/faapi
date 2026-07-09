# 场景:调试与错误排查

## 何时加载

dev 启动失败、路由不生效、类型校验 400、500 错误、行为与预期不符。

## 错误状态码速查

| 状态码 | 原因 | 排查方向 |
|--------|------|---------|
| 400 | query/body/params 缺失或非法 | 类型校验失败 |
| 404 | 路由不存在 | 文件位置/路径映射 |
| 405 | 方法不允许 | handler 导出的方法 |
| 500 | 模块加载失败/handler 异常 | 服务端日志 |

## 400 — 类型校验失败

### 现象

```json
{ "error": "Validation failed: page expected number, got string" }
```

### 原因

- 必填字段缺失:`?page=` 缺少 page
- 类型不匹配:`?page=abc` 但声明 `page: number`
- 嵌套对象字段缺失
- 数组元素类型错误

### 排查

1. **检查 interface 声明**

```ts
export interface Query {
  page: number;       // 必填,?page= 必须提供
  name?: string;      // 可选,加 ?
}
```

2. **检查请求参数**

```bash
curl 'http://localhost:3000/api/user?page=1&pageSize=10'
# 不要用 page=abc
```

3. **URL 参数是 string,声明 number 才自动转换**

`?page=1` → string `'1'` → faapi 自动转 number `1`。声明 `page: string` 则保持 `'1'`。

### AST 不支持的类型

直接抛 `SchemaExtractionError`,不降级:

```ts
// ❌ WeakMap/WeakSet/Promise 不支持
export interface Bad {
  data: WeakMap<string, number>;
}

// ❌ any/void/never/object 抛错
export interface Bad {
  data: any;
}

// ✅ 用 Map<K,V> / Set<T> 或对象
export interface Good {
  data: Map<string, number>;
}

// ✅ unknown 表示不校验
export interface Anything {
  data: unknown;
}
```

`Map<K,V>` 与 `Set<T>` 已支持,但客户端需以 entries 数组 / 数组形式发送(JSON 序列化 Map/Set 会丢失数据)。详见 [route.md](./route.md) 的 "Map / Set 类型" 章节。

## 404 — 路由不存在

### 原因

1. 文件位置不对
2. 路径映射错误
3. dev 模式未扫描到文件

### 排查

1. **检查文件位置**

```
❌ api/user/handler.ts      ← 路由根目录固定为 src/，扫描 src/api/ 不是 api/
❌ app/user/handler.ts          ← 必须在 api/ 下
✅ src/api/user/handler.ts
```

2. **检查 URL**

```
api/user/handler.ts → /api/user(不是 /user)
api/user/[id]/handler.ts → /api/user/123
```

3. **检查启动参数**

路由源码目录固定为 `src/`，需将路由放在 `src/api/` 下。框架元信息（port/dist）通过环境变量传入,不在 `faapi.config.ts` 中配置。

4. **查看启动日志**

```
- Routes: 3 route(s), 1 WS route(s)
  - GET  /api/user
  - POST /api/user
  - GET  /api/user/:id
```

如果路由数 0,说明没扫描到文件。

## 405 — 方法不允许

### 原因

handler 文件存在,但没导出对应的 HTTP 方法。

### 排查

```ts
// src/api/user/handler.ts

// 只导出了 GET
export function GET() { ... }

// POST /api/user → 405
// DELETE /api/user → 405
```

需要支持哪些方法就导出哪些:`GET`/`POST`/`PUT`/`DELETE`/`PATCH`。

## 500 — 服务端错误

### 原因

1. handler 抛错
2. 模块加载失败
3. 注入器抛错
4. **未安装 zod**(peerDependencies 缺失)

### 排查

1. **查看服务端日志**(终端输出)

```
- Error: Cannot find module '../../utils/db'
```

2. **handler 异常**

```ts
export function GET(ctx) {
  throw new Error('boom');  // 500
}
```

3. **未安装 zod**

```
Error: Cannot find package 'zod' imported from .faapi/api/user/zod.js
```

**原因**:`zod` 是 faapi 的 `peerDependencies`,业务方需自行安装。框架生成的 `zod.js` 顶部为 `import { z } from 'zod'`,从业务方项目目录向上查找 `node_modules/zod`,找不到就报错。

**触发时机**:首次请求带类型声明的 handler 时(`validateInput` 按需 import `zod.js` 触发)。无类型声明的 handler 不触发 schema 校验,不会报错。

**解决**:

```bash
pnpm add zod@^4
# 或
npm install zod@^4
```

> **为什么是 peerDependencies**:pnpm 严格 node_modules 布局下,`zod` 若放在 `@faapi/faapi` 的 `dependencies`,会被隔离到 `node_modules/@faapi/faapi/node_modules/zod`,不会提升到项目根。Node ESM 解析器从业务方目录下的 `zod.js` 向上查找 `node_modules/zod` 失败,导致运行时报错。改为 peerDependencies 强制业务方在项目根安装,确保 `zod.js` 能解析到。

**验证**:`pnpm ls zod` 应显示 `zod 4.x`。

配置全局错误中间件自定义错误响应,配置 `lifecycle.onError` 记录日志:

```ts
import type { FaapiMiddleware } from '@faapi/faapi';

const errorHandler: FaapiMiddleware = async (ctx, next) => {
  try {
    await next();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return ctx.json({ error: message }, 500);
  }
};

export default {
  middlewares: [errorHandler],
  lifecycle: {
    onError(error, ctx) {
      console.error(`[onError] ${ctx.method} ${ctx.path}`, error);
    },
  },
};
```

## dev 启动失败

### 1. 端口被占

```
Error: listen EADDRINUSE: address already in use :::3000
```

**解决**:设置 `PORT` 环境变量换端口,或杀掉占用进程。

### 2. 配置文件语法错误

```
Error loading config: Unexpected token }
```

**解决**:检查 `faapi.config.ts` 语法。

### 3. 路由扫描失败

```
- Routes: 0 route(s)
```

**原因**:
- `api/` 下没有 `handler.ts`
- patterns 不匹配

**解决**:检查文件位置。

### 4. 模块加载失败

```
Error: Cannot find module './handler'
```

**原因**:tsconfig 配置为 `moduleResolution: Bundler`,但运行时用了不支持无后缀解析的工具(如直接 `node dist/index.js` 而未经过 tsup 打包)。

**解决**:本地相对导入路径不写后缀,由 tsc/tsup/esbuild 解析。

```ts
// ✅ 正确:无后缀
import { foo } from './utils';

// ❌ 错误:写 .js 后缀
import { foo } from './utils.js';

// ❌ 错误:写 .ts 后缀
import { foo } from './utils.ts';
```

> 注:dev 模式 esbuild 编译支持 Bundler 解析(无后缀导入由 esbuild 解析);prod 模式由 tsup 打包成单文件,无相对路径问题。faapi.config.ts 也由 esbuild 编译为临时 .mjs 后 import。

## prod 启动失败

### 1. dist/faapi-routes.js 或 zod.js 不存在

```
[faapi] dist/faapi-routes.js 或 zod.js 不存在,请先执行 `faapi build` 构建生产产物。
```

**原因**:没跑 `faapi build` 就用 `node dist/main` 启动。

**解决**:

```bash
faapi build
node dist/main
```

### 2. 路由文件未编译

```
Error: Cannot find module 'dist/api/user/handler.js'
```

**原因**:`faapi build` 没编译路由文件,或 patterns 不匹配。

**解决**:

```bash
faapi build  # 重新编译
```

## watch 模式问题

### 1. 文件变化没触发重建

**原因**:
- 文件不在 watch patterns 内
- 文件在 `node_modules`/`dist` 等忽略目录

**解决**:检查 `src/api/**/*.ts` 是否匹配,文件是否在忽略目录。

### 2. 重建报错

```
- Error rebuilding routes: ...
```

**原因**:handler 文件语法错误或导入错误。

**解决**:查看错误信息,修复后保存,watch 会自动重试。

## 类型校验不生效

### 现象

handler 参数类型声明了,但请求传错参数也不报 400。

### 原因

1. 参数名不是内置注入名(`query`/`body`/`params` 等)
2. 类型声明在函数外部,handler 没用
3. 用了 AST 不支持的类型(抛 `SchemaExtractionError`,不会静默降级)

### 排查

```ts
// ❌ 参数名不对
export function GET(searchQuery: Query) { ... }
// searchQuery 不是内置注入名,不会校验

// ✅ 用 query
export function GET(query: Query) { ... }
```

```ts
// ❌ 类型声明了但 handler 参数用 any（会抛 SchemaExtractionError,不是静默不校验）
interface Query { page: number; }
export function GET(query: any) { ... }
// 用 unknown 表示不校验:export function GET(query: unknown) { ... }
```

## dev/build 不报类型错误

### 现象

```ts
export interface Query { page: number; }
export function GET(query: Query) {
  return query.unknownProp;  // dev/build 都不报错,运行时 undefined
}
```

### 原因

dev 和 build 都用 esbuild 编译,**只编译不检查类型**。框架不主动跑 tsc。

### 解决

用户自己跑 `pnpm typecheck`:

```bash
pnpm typecheck  # tsc --noEmit
```

或者依赖 IDE 实时检查(VSCode/WebStorm 写代码时就会标红)。

详见 [SKILL.md](./SKILL.md) 的"设计原则"部分。

## 跨文件类型引用问题

### 现象

handler 引用了其他文件的类型,dev 模式校验不生效。

### 原因

dev 模式 watch 增量编译 + 重新生成 schema,跨文件类型引用应该自然解决。如果还有问题:

1. 循环引用

### 排查

```ts
// ✅ 正确:Bundler 模式无后缀
import type { User } from '../../types';

// ❌ 错误:写 .js 或 .ts 后缀
import type { User } from '../../types.js';
import type { User } from '../../types.ts';
```

## 问题反馈与处理流程(vibe coding 场景)

用 AI 辅助开发 faapi 应用时,遇到 faapi 自身的问题(功能缺口/文档错误/行为异常),按本流程记录并反馈。这是反馈机制,不阻塞当前开发——有变通方案就先推进业务,同步把问题沉淀到 TODO 文档,便于 faapi 持续优化。

### 三类问题

| 类型 | 文件 | 典型场景 |
|------|------|---------|
| 功能缺口 | `TODO-faapi-gaps.md` | AST 不支持的类型抛 `SchemaExtractionError`、框架缺失内置能力(rateLimit/cluster 等,参考 [recipes.md](./recipes.md))、配置/中间件/注入暂不支持 |
| 文档错误 | `TODO-faapi-docs-fix.md` | 文档描述与源码实际行为不符(如"不声明 body 时框架不预读"实际会预读)、示例代码跑不通 |
| 行为异常 | `TODO-faapi-bugs.md` | 框架行为不符合预期(疑似 bug)、运行时报错无法绕过 |

> 三类文件放在**业务项目根目录**(不是 faapi 仓库),按需创建,不存在就不建。文件名固定,便于跨项目识别。

### 处理流程

```
遇到问题
  ↓
1. 先查 faapi 源码确认(读源码定位文件+行号,不靠猜测)
  ↓
2. 有变通方案?
  ├─ 是 → 变通推进业务,同步在对应 TODO 文件记录
  └─ 否 → 标记 🔴 阻塞,TODO 记录 + 提 issue 反馈
  ↓
3. TODO 记录(含源码依据 + 场景 + 期望 + 实际 + 变通)
  ↓
4. 反馈到 faapi 仓库(提 issue 或直接 PR 修正)
  ↓
5. faapi 侧修复 + 验证(grep / typecheck / test)
  ↓
6. 业务项目删除对应 TODO 条目(或整个文件)
```

**关键原则**:记录前**必须读 faapi 源码确认问题真实性**,引用文件+行号作为依据。避免把用法错误误判为框架问题——先确认是文档错、框架 bug,还是自己用法不对。

### 记录格式

每个 TODO 文件按问题编号,每条记录:

```markdown
## [YYYY-MM-DD] <简短标题>

- **场景**: <遇到的具体场景,含报错信息或现象>
- **源码依据**: <faapi 源码文件+行号,证明问题真实性>
- **期望**: <希望 faapi 提供的能力/正确行为>
- **实际**: <当前实际行为>
- **当前变通**: <临时绕过方案,无则写"无(阻塞)">
- **相关文件**: <业务项目里受影响的文件路径>
- **验证清单**: <修复后如何验证,如 grep 命令/typecheck/test>(可选)
```

### 实战示例

#### 功能缺口:handler 用了 AST 不支持的类型

```markdown
## [2026-07-09] AST 不支持 Promise 类型

- **场景**: handler 参数声明 `data: Promise<number>`,dev 启动抛 SchemaExtractionError: Unsupported type Promise
- **源码依据**: packages/faapi/src/validator/extractRuntimeType.ts 类型 switch 无 Promise 分支(直接抛错,不降级)
- **期望**: AST 支持 Promise<T>,或提供降级策略
- **实际**: 直接抛 SchemaExtractionError
- **当前变通**: 改用 number,异步逻辑移到 handler 内部 await
- **相关文件**: src/api/user/handler.ts
```

#### 文档错误:文档与源码行为不符

```markdown
## [2026-07-09] 文档错误:声称"不声明 body 时框架不预读请求体"

- **场景**: 按文档用 `ctx.request.json()` 读取请求体,抛 "Body has already been read"
- **源码依据**:
  - packages/faapi/src/server/createServer.ts L296 `resolveInput` 无条件调用
  - packages/faapi/src/runtime/resolveInput.ts L30/L51 POST/PUT/PATCH 无条件 `await request.text()`
  - packages/faapi/src/runtime/inputType.ts L11-17 非 GET/DELETE/HEAD 返回 'body'
- **期望**: 文档说明 POST/PUT/PATCH 始终预读请求体,正确用法是声明 body 参数
- **实际**: 文档错误描述为"不声明 body 时框架不预读"
- **当前变通**: 声明 body 参数(可用 index signature 允许开放字段透传)
- **相关文件**: src/api/v1/chat/completions/handler.ts
- **验证清单**:
  - [ ] grep "不声明.*body.*框架不预读" 无匹配
  - [ ] grep "ctx.request.(json|text)" 仅匹配 GET 场景或"不能用"警示
```

#### 行为异常:疑似 bug

```markdown
## [2026-07-09] SSE aborted 后 send 仍写入(疑似)

- **场景**: 客户端断开后 sse.send 未静默忽略,抛 TypeError
- **源码依据**: packages/faapi/src/runtime/sse.ts send 守卫检查 closed/aborted
- **期望**: aborted 后 send 静默忽略(文档承诺)
- **实际**: <附复现步骤 + 堆栈>
- **当前变通**: 无(阻塞)
- **相关文件**: src/api/stream/handler.ts
```

### 反馈到 faapi 仓库

TODO 记录后,按问题类型反馈:

- **功能缺口**:提 issue,标题 `[gaps] <简述>`,附 TODO 全文;或直接 PR 实现(走 DDD 流程:文档→测试→代码)
- **文档错误**:直接 PR 修正 faapi 文档(低风险,无需 issue),commit message 用 `docs: ...`
- **行为异常**:提 issue,标题 `[bug] <简述>`,附复现步骤 + 源码依据

修复合并后,**删除业务项目里对应的 TODO 文件**(或条目)。保留已修复的 TODO 会误导后续开发。

## 检查清单

### 启动问题
- [ ] `api/` 下有 `handler.ts`
- [ ] `faapi` 命令在项目根目录运行
- [ ] `pnpm typecheck` 通过
- [ ] `pnpm build` 成功(prod 模式)
- [ ] 端口未被占用
- [ ] `pnpm ls zod` 显示 `zod 4.x`(peerDependencies 必装)

### 路由问题
- [ ] 文件位置正确(`api/<路径>/handler.ts`)
- [ ] 导出 HTTP 方法名
- [ ] URL 包含 `/api/` 前缀
- [ ] 启动日志显示路由数 > 0

### 类型校验问题
- [ ] 参数名是内置注入名(`query`/`body`/`params`)
- [ ] 类型用 `interface` 声明
- [ ] 可选字段加 `?`
- [ ] 不用 `any`/`void`/`never`/`object`/`WeakMap`/`WeakSet` 等 AST 不支持的类型
- [ ] 用 `Map<K,V>` / `Set<T>` 时客户端以 entries 数组 / 数组形式发送

### 错误处理
- [ ] 配置全局错误中间件 `try/catch next()` 自定义错误响应
- [ ] 配置 `lifecycle.onError` 记录日志
- [ ] 查看终端服务端日志

## 相关场景

- [init.md](./init.md) — 项目结构、CLI 参数
- [route.md](./route.md) — 路由约定、类型校验
- [config.md](./config.md) — 全局中间件、onError
- [response.md](./response.md) — 全局错误中间件模式
