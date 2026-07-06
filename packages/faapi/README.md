# faapi

> 函数即接口 — Function as API

faapi 是一个 Node.js 框架，核心理念是"函数即接口"。编写普通 TypeScript 函数即可暴露为 HTTP / WebSocket 接口，类型校验由 TypeScript AST 自动生成，无需手写 schema。

## 安装

```bash
pnpm add @faapi/faapi
# 或
npm install @faapi/faapi
```

要求 Node.js >= 24。faapi 仅支持 ESM（`type: "module"`），不提供 CJS 产物。

## 快速开始

```ts
// api/user/handler.ts
export interface Query {
  page: number;
  pageSize: number;
}

export function GET(query: Query) {
  return { page: query.page, pageSize: query.pageSize };
}
```

```bash
# 启动 dev server
npx faapi
```

访问 `http://localhost:3000/api/user?page=1&pageSize=10` 即可。

```bash
# 生产部署
faapi build                # 编译 .ts → dist/，生成路由清单 + schema + dist/main.js
node dist/main             # 启动生产服务器
```

## 核心能力

- 函数即接口：导出 `GET`/`POST` 等函数即声明路由
- AST 类型校验：TypeScript Compiler API 自动生成运行时校验
- 洋葱模型中间件：`(ctx, next) => {}`
- 依赖注入：注入器按参数名匹配 handler 参数
- WebSocket 路由：导出 `WS` 函数声明
- SSE 流式响应：`ctx.sse()` 推送
- 动态路由：`[id]` / `[...slug]` / `(group)`
- MCP 集成：LLM 可查询路由 schema
- 配置文件：`faapi.config.ts` 统一响应格式、全局错误处理、生命周期钩子、全局中间件/注入器
- ESM only

## 文档

完整文档见 [GitHub 仓库](https://github.com/faapi/faapi#readme)。

- [架构与约定](https://github.com/faapi/faapi/blob/main/AGENTS.md)
- [中间件系统](https://github.com/faapi/faapi/blob/main/packages/faapi/src/middleware/README.md)
- [路由系统](https://github.com/faapi/faapi/blob/main/packages/faapi/src/router/README.md)
- [运行时](https://github.com/faapi/faapi/blob/main/packages/faapi/src/runtime/README.md)
- [配置](https://github.com/faapi/faapi/blob/main/packages/faapi/src/config/README.md)
- [CLI](https://github.com/faapi/faapi/blob/main/packages/faapi/src/cli/README.md)

## 许可证

[MIT](https://github.com/faapi/faapi/blob/main/LICENSE)
