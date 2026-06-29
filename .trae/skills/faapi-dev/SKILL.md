---
name: "faapi-dev"
description: "使用 faapi 框架开发应用。Invoke when 用户要基于 faapi 写 API 路由、中间件、WebSocket、SSE、配置文件、集成 Next.js，或遇到 dev/prod 行为差异、类型校验、错误排查等问题时。"
---

# faapi 应用开发

## 何时使用

用户基于 faapi 框架开发应用(API/中间件/WS/SSE/配置/集成),或排查 faapi 相关问题时。

## 场景路由

根据用户意图,加载对应的场景文档(本目录下):

| 用户意图 | 加载文档 | 典型场景 |
|---------|---------|---------|
| 初始化项目 / 安装依赖 / 启动服务 / 集成 Next.js | [init.md](./init.md) | 新建项目、`faapi` 启动、`@faapi/next` 集成 |
| 写 handler / 路由参数 / 动态路由 / catch-all | [route.md](./route.md) | `api/user/handler.ts` |
| 写中间件 / 洋葱模型 / 鉴权 / 日志 / 错误处理 | [middleware.md](./middleware.md) | `middlewares.ts` |
| 写注入器 / 自定义依赖 / `injectors` 配置 | [injection.md](./injection.md) | `export const injectors` |
| 写配置文件 / responseFormat / errorFormat / 生命周期钩子 / 多环境 / 插件 / `@faapi/next` 集成 | [config.md](./config.md) | `faapi.config.ts` |
| 写 WebSocket / SSE / 流式响应 / 长连接 | [realtime.md](./realtime.md) | `WS` 导出 / `ctx.sse()` |
| dev 启动失败 / 路由不生效 / 类型校验 400 / 500 错误 / 行为与预期不符 | [debug.md](./debug.md) | 排查问题 |

## 使用方式

1. **识别用户意图** — 从用户消息判断属于哪个场景
2. **加载对应 .md** — 用 Read 工具读取本目录下对应的场景文档
3. **按文档指引执行** — 文档包含该场景的规范、示例、常见坑点、检查清单

如果一个请求跨多个场景(如"写一个带鉴权中间件的动态路由"),按主场景加载,其余场景按需参考。

## 使用形态

faapi 作为独立服务运行,用 `faapi` 命令启动。默认扫描 `api/**/*.ts`。

```bash
pnpm add @faapi/faapi
faapi                    # 启动 dev server
```

## 集成 Next.js

通过 `@faapi/next` 插件,单进程单端口集成 Next.js 和 faapi:`/api/*` 走 faapi,其余走 Next.js。

```bash
pnpm add @faapi/faapi @faapi/next next
```

```ts
// faapi.config.ts
import type { FaapiConfig } from '@faapi/faapi';

export default {
  plugins: ['@faapi/next'],
} satisfies FaapiConfig;
```

```bash
faapi                  # 用 faapi 主 CLI 启动,自动加载 @faapi/next 插件
```

详见 [config.md](./config.md) 的插件章节。

## 核心约定(所有场景通用)

- **路由根目录**:CLI 默认 `api/`,文件名 `handler.ts`(可通过 `--app-dir` 调整)
- **中间件文件**:`middlewares.ts`,与 `handler.ts` 同目录或父目录,默认导出中间件数组
- **包管理器**:pnpm
- **模块系统**:ESM,`moduleResolution: Bundler`,本地相对导入路径不写后缀(由 tsc/tsx/tsup/esbuild 解析)
- **dev 启动**:`faapi`(默认扫描 `api/**/*.ts`,用 tsx 转译,不跑 tsc)
- **prod 启动**:`NODE_ENV=production faapi`(加载 `dist/` 下编译后的 `.js`)
- **构建**:`faapi build`(用 esbuild 编译,生成 `dist/`)
- **类型校验**:dev 不自动跑 tsc,用户需自己跑 `pnpm typecheck`(`tsc --noEmit`);CI 会自动跑

## 插件系统

faapi 通过 `faapi.config.ts` 的 `plugins` 字段声明式加载扩展。插件可在 server.listen 之前包装 HTTP/WS handler,用于集成其他框架。

```ts
export default {
  plugins: [
    '@faapi/schema',                          // 路由 schema 通过 MCP 暴露给 AI 助手
    '@faapi/next',                            // 集成 Next.js
    ['@faapi/next', { dir: '.', apiPrefix: '/api' }],  // 带选项
  ],
} satisfies FaapiConfig;
```

插件通过 `ctx.wrapHandler` / `ctx.wrapUpgradeHandler` 注册包装函数,框架在 listen 之前按注册顺序嵌套应用。详见 [config.md](./config.md)。

## dev 与 prod 行为差异

| 维度 | dev | prod |
|------|-----|------|
| 启动命令 | `faapi` | `NODE_ENV=production faapi` |
| 文件类型 | `.ts`(tsx 转译) | `.js`(已编译) |
| schema 来源 | 启动时全量 AST 提取 | 加载 `dist/faapi-schema.js` |
| watch 模式 | ✅ 文件变化全量重建 | ❌ |
| tsc 检查 | ❌(用户自己跑) | ❌(应在 CI 已检查) |
| 路由 patterns | `api/**/*.ts` | `dist/api/**/*.js` |
| 插件加载时机 | server.listen 之前 | server.listen 之前 |

## 设计原则

faapi 遵循"**只转译不检查类型**"的框架职责边界。框架用 tsx/esbuild 追求启动速度,**不主动做 tsc 检查**。类型安全由三层保证:

1. **IDE 实时检查**(VSCode/WebStorm 写代码时即时提示)
2. **用户项目** `pnpm typecheck`(`tsc --noEmit`)
3. **CI 类型检查**(`.github/workflows/ci.yml`)

框架不重复承担 TypeScript 编译器的工作。

## 包结构

```
@faapi/faapi           核心包:API 路由、中间件、注入、校验、AST 能力公开导出
@faapi/schema          扩展包:路由 schema 生成 + 通过 MCP 协议暴露给 AI 助手
@faapi/next            扩展包:Next.js + faapi 集成插件(通过 plugins 加载)
```

`@faapi/schema` 和 `@faapi/next` 均为可选扩展,通过 `faapi.config.ts` 的 `plugins` 字段声明加载——未安装时自动跳过,不影响核心功能。

## 与 DDD 的关系

faapi 项目自身用 DDD 模式开发(`.trae/skills/ddd/SKILL.md`),但**用户使用 faapi 开发应用时不强制 DDD**。用户只按场景文档写 handler/中间件/配置即可,无需写 .md 文档。

## 参考资料

- [AGENTS.md](../../../AGENTS.md) — faapi 项目顶层文档(架构、约定、验收标准)
- [.trae/skills/ddd/SKILL.md](../ddd/SKILL.md) — DDD 通用规范(faapi 项目自身开发用)
