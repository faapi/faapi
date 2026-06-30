# faapi

> 函数即接口 — Function as API

faapi 是一个 Node.js 框架，核心理念是"函数即接口"。编写普通 TypeScript 函数即可暴露为 HTTP / WebSocket 接口，类型校验由 TypeScript AST 自动生成，无需手写 schema。

## 特性

- **函数即接口**：导出 `GET`/`POST` 等函数即声明路由，无需装饰器、无需手写 schema
- **AST 类型校验**：TypeScript Compiler API 分析接口参数类型，自动生成运行时校验函数
- **洋葱模型中间件**：单一 async 函数 `(ctx, next) => {}`，`await next()` 前后衔接前置/后置逻辑
- **依赖注入**：注入器（injector）按参数名匹配 handler 参数，与中间件解耦
- **WebSocket 路由**：导出 `WS` 函数即声明 WS 路由，握手阶段复用洋葱中间件鉴权
- **SSE 流式响应**：`ctx.sse()` 返回 `SseWriter`，适用于 LLM 流式输出、通知推送
- **动态路由**：`[id]` 动态参数、`[...slug]` catch-all、`(group)` 分组
- **MCP 集成**：LLM 可查询路由 schema
- **配置文件**：`faapi.config.ts` 支持统一响应格式、全局错误处理、生命周期钩子、全局中间件/注入器
- **ESM only**：原生 ES Modules，Node.js >= 22

## 快速开始

### 安装

```bash
pnpm add @faapi/faapi
# 或
npm install @faapi/faapi
```

### 创建第一个接口

```ts
// api/user/handler.ts
export interface Query {
  page: number;
  pageSize: number;
}

export interface CreateUserBody {
  name: string;
  email: string;
}

export function GET(query: Query) {
  return { page: query.page, pageSize: query.pageSize };
}

export function POST(body: CreateUserBody) {
  return { created: true, name: body.name };
}
```

### 启动开发服务器

```bash
# 默认扫描 src/api/**/*.ts
faapi

# 指定路由 pattern
faapi src/api/auth/*

# 指定端口
faapi --port 3000
```

访问 `http://localhost:3000/api/user?page=1&pageSize=10` 即可获取数据。

## CLI 命令

```bash
faapi                      # 启动 dev server（默认，扫描 src/api/）
faapi dev                  # 同上
faapi src/api/auth/*       # 指定路由 pattern
faapi --port 3000          # 指定端口
faapi --app-dir .          # 回退到项目根目录（扫描 api/）
faapi --static public      # 托管静态文件
faapi --no-cors            # 禁用 CORS
faapi --types faapi-types.ts  # 生成 RPC 类型文件
faapi --config faapi.config.ts  # 指定配置文件
faapi build                # 构建
```

## 文档

- [AGENTS.md](./AGENTS.md) — 项目定位、架构、约定、验收标准（项目唯一顶层文档）
- [中间件系统](./packages/faapi/src/middleware/README.md)
- [路由系统](./packages/faapi/src/router/README.md)
- [运行时](./packages/faapi/src/runtime/README.md)
- [配置](./packages/faapi/src/config/README.md)
- [AST 类型校验](./packages/faapi/src/ast/README.md)
- [CLI](./packages/faapi/src/cli/README.md)
- [WebSocket](./packages/faapi/src/runtime/wsHandler.md)
- [SSE](./packages/faapi/src/runtime/sse.md)

本项目使用 **DDD（Documentation-Driven Development）** 模式开发，流程为：**文档 → 测试 → 代码 → 通过**。详见 [AGENTS.md](./AGENTS.md)。

## 许可证

[MIT](./LICENSE)
