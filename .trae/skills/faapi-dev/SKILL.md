---
name: "faapi-dev"
description: "使用 faapi 框架开发应用。Invoke when 用户要基于 faapi 写 API 路由、中间件、WebSocket、SSE、配置文件、集成 Next.js，或遇到 dev/prod 行为差异、类型校验、错误排查等问题时。"
---

# faapi 应用开发

## 何时使用

用户基于 faapi 框架开发应用(API/中间件/WS/SSE/配置/集成),或排查 faapi 相关问题时。

## 场景路由

根据用户意图,加载对应的场景文档:

| 用户意图 | 加载文档 | 典型场景 |
|---------|---------|---------|
| 初始化项目 / 安装依赖 / dev 启动 / prod 构建 | [init.md](./init.md) | 新建项目、`faapi` / `faapi build` |
| 写 handler / 路由参数 / 动态路由 / catch-all / 方法导出 | [route.md](./route.md) | `api/user/handler.ts` |
| 写中间件 / 洋葱模型 / 鉴权 / 日志 | [middleware.md](./middleware.md) | `middlewares.ts` |
| 写注入器 / 自定义依赖 | [injection.md](./injection.md) | `export const injectors` |
| 写配置文件 / 了解所有配置字段 | [config.md](./config.md) | `faapi.config.ts` |
| 配置 CORS | [cors.md](./cors.md) | `cors: { origin: '*' }` |
| 统一响应格式 / 自定义错误响应 | [response.md](./response.md) | `ok()` 辅助函数、全局错误中间件 |
| 配置生命周期钩子 | [lifecycle.md](./lifecycle.md) | `lifecycle: { onReady, onClose, onError }` |
| 扩展 ctx | [extend-context.md](./extend-context.md) | `extendContext(ctx) { ... }` |
| 写插件 / 集成 Next.js | [plugins.md](./plugins.md) | `@faapi/next` 集成 |
| 多环境配置 | [multi-env.md](./multi-env.md) | `.env` / `.env.production` |
| 写 WebSocket / SSE / 流式响应 | [realtime.md](./realtime.md) | `WS` 导出 / `ctx.sse()` |
| ETag / compression / rateLimit / cluster 等自实现功能 | [recipes.md](./recipes.md) | 业务方自行实现中间件示例 |
| dev 启动失败 / 路由不生效 / 400/500 错误 排查 | [debug.md](./debug.md) | 排查问题 |
| 测试 handler / 中间件 / 注入器 / E2E / WebSocket 路由 | [testing.md](./testing.md) | `createContext` + `invokeHandler` 无服务器测试 / `createTestServer` + `fetch` E2E / `connectWs` WS 路由 |

## 使用方式

1. **识别用户意图** — 从用户消息判断属于哪个场景
2. **加载对应 .md** — 用 Read 工具读取对应的场景文档
3. **按文档指引执行** — 文档包含该场景的规范、示例、常见坑点、检查清单

如果一个请求跨多个场景(如"写一个带鉴权中间件的动态路由"),按主场景加载,其余场景按需参考。

## 核心约定(所有场景通用)

- **路由根目录**:固定为 `src/api/`,文件名 `handler.ts`
- **中间件文件**:`middlewares.ts`,与 `handler.ts` 同目录或父目录
- **包管理器**:pnpm
- **模块系统**:ESM,`moduleResolution: Bundler`,本地相对导入路径不写后缀
- **dev 启动**:`faapi` / `faapi dev`
- **prod 构建**:`faapi build` → `node dist/main`
- **类型校验**:dev 和 build 都不做类型检查（esbuild 只编译不检查类型），用户需自己跑 `pnpm typecheck`
- **zod 依赖**:`zod@^4` 是 faapi 的 `peerDependencies`,业务方必须自行安装。框架生成的 `zod.js`(每个 handler 一个,运行时按需 import 做 `safeParse`)位于业务方项目目录,顶部固定为 `import { z } from 'zod'`,需项目根 `node_modules` 可解析到 zod。未安装时首次请求会报 `Cannot find package 'zod'`
- **问题反馈**:vibe coding 遇到 faapi 自身问题(功能缺口/文档错误/行为异常)时,在业务项目根目录维护分类 TODO 文件(`TODO-faapi-gaps.md`/`TODO-faapi-docs-fix.md`/`TODO-faapi-bugs.md`),记录场景 + **源码依据(文件+行号)** + 期望 + 实际 + 变通 + 验证清单,反馈到 faapi 仓库;修复后删除对应 TODO。详见 [debug.md](./debug.md) 的"问题反馈与处理流程"章节。

## 使用形态

```bash
pnpm add @faapi/faapi zod@^4
faapi                    # 启动 dev server
```

集成 Next.js:

```bash
pnpm add @faapi/faapi @faapi/next next zod@^4
```

```ts
// faapi.config.ts
export default {
  plugins: ['@faapi/next'],
} satisfies FaapiConfig;
```

详见 [plugins.md](./plugins.md)。
