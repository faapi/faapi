# 场景:项目初始化

## 何时加载

用户要新建 faapi 项目、安装依赖、启动服务,或询问项目结构,或要集成 Next.js。

## 项目结构

### CLI 形态

```
my-app/
├── src/
│   └── api/
│       └── user/
│           └── handler.ts      ← 路由文件
├── faapi.config.ts             ← 配置文件(可选)
├── tsconfig.json
├── package.json
└── faapi-types.ts               ← 自动生成的 RPC 类型(可选)
```

### 集成 Next.js 形态

```
my-app/
├── src/
│   └── api/                     ← faapi 路由
│       └── user/handler.ts
├── app/                         ← Next.js App Router
│   └── page.tsx
├── faapi.config.ts             ← 声明 @faapi/next 插件
├── next.config.ts               ← Next.js 配置
└── package.json
```

## 初始化步骤

### 1. 创建项目

```bash
mkdir my-app && cd my-app
pnpm init
```

### 2. 安装 faapi

```bash
pnpm add @faapi/faapi
```

可选扩展(路由 schema 通过 MCP 暴露给 AI 助手):

```bash
pnpm add @faapi/schema
```

### 3. 配置 package.json scripts

```json
{
  "scripts": {
    "dev": "faapi",
    "build": "faapi build",
    "start": "faapi start",
    "typecheck": "tsc --noEmit"
  }
}
```

> 注:`start` 通过 `faapi start` 命令启动(从 `node_modules/.bin/faapi` 软链)。如果全局未安装,用 `pnpm exec faapi start`。

### 4. 创建 tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "./dist",
    "rootDir": "./",
    "types": ["node"]
  },
  "include": ["src/api/**/*.ts", "faapi.config.ts", "faapi-types.ts"],
  "exclude": ["node_modules", "dist"]
}
```

**关键**:`include` 必须包含 `src/api/**/*.ts`,这样 `tsc --noEmit` 才能检查 handler 内部的类型错误(如 `query.unknownProp`)。

### 5. 创建第一个路由

```ts
// src/api/user/handler.ts
export interface Query {
  page: number;
  pageSize: number;
}

export function GET(query: Query) {
  return { page: query.page, pageSize: query.pageSize };
}
```

### 6. 启动 dev server

```bash
pnpm dev
# 或
faapi
```

默认行为:
- 扫描 `src/api/**/*.ts`
- 启动 watch 模式(文件变化自动重建路由)
- 自动启用 CORS
- 端口 3000

访问 `http://localhost:3000/api/user?page=1&pageSize=10`,返回:

```json
{ "page": 1, "pageSize": 10 }
```

> **注意**:URL 参数都是 string,faapi 通过 AST 类型校验自动转换。声明 `page: number` 时,传入 `?page=abc` 会返回 400。

## CLI 参数

```bash
faapi                           # 启动 dev(默认)
faapi dev                       # 同上
faapi api/auth/*            # 指定路由 pattern
faapi --port 3000               # 指定端口
faapi --app-dir .           # 回退到项目根目录(扫描 api/)
faapi --static public           # 托管静态文件
faapi --no-cors                 # 禁用 CORS
faapi --types faapi-types.ts    # 生成 RPC 类型文件
faapi --config faapi.config.ts  # 指定配置文件
faapi build                     # 构建(不启动服务器)
faapi start                     # 启动生产服务器(需先 build)
```

## 构建与生产部署

```bash
# 构建(编译 .ts → dist/*.js + 生成 dist/faapi-routes.js + dist/faapi-schema.js)
pnpm build

# 生产启动
faapi start
# 或
pnpm start
```

**prod 模式触发条件**:
1. 使用 `faapi start` 命令(不再通过 `NODE_ENV=production` 切换)
2. `dist/faapi-routes.js` 和 `dist/faapi-schema.js` 存在(由 `faapi build` 生成)

prod 行为:
- 读 `dist/faapi-routes.js` 路由清单 + 水合中间件(不扫描文件系统)
- 从 `dist/faapi-schema.js` 加载 schema(不跑 AST 提取)
- 兜底设置 `NODE_ENV=production`(未显式设置时,同步给生态下游如 Next.js)
- 不启动 watch

## 集成 Next.js 形态初始化

通过 `@faapi/next` 插件,单进程单端口集成 Next.js 和 faapi。

### 1. 安装依赖

```bash
pnpm add @faapi/faapi @faapi/next next
```

### 2. 声明插件

```ts
// faapi.config.ts
import type { FaapiConfig } from '@faapi/faapi';

export default {
  plugins: [
    '@faapi/next',
    // 或带选项: ['@faapi/next', { dir: '.', apiPrefix: '/api' }],
  ],
} satisfies FaapiConfig;
```

### 3. 创建路由文件

```ts
// src/api/user/handler.ts  ← faapi 路由(CLI 默认扫描 src/api/)
export function GET() {
  return { name: 'foo' };
}
```

```tsx
// app/page.tsx  ← Next.js 页面（faapi 用 api/，Next.js 用 app/，目录分离）
export default function Home() {
  return <h1>Hello Next.js + faapi</h1>;
}
```

### 4. 启动

```bash
faapi                  # 用 faapi 主 CLI 启动,自动加载 @faapi/next 插件
```

- `http://localhost:3000/api/user` → faapi 处理
- `http://localhost:3000/` → Next.js 处理

### 5. 生产部署

```bash
faapi build           # 构建 faapi(生成 dist/faapi-routes.js + dist/faapi-schema.js)
next build            # 构建 Next.js(faapi 不代理 next build,用户自己跑)
faapi start           # 启动(读 dist 产物,NODE_ENV 自动兜底为 production)
```

### 插件选项

| 选项 | 默认值 | 说明 |
|------|--------|------|
| `dev` | `NODE_ENV !== 'production'` | 开发模式 |
| `dir` | `'.'` | Next.js 项目目录 |
| `apiPrefix` | `'/api'` | faapi API 路径前缀(决定哪些请求走 faapi) |

## 常见坑点

### 1. handler 文件位置错误

```
❌ api/user/handler.ts     ← 默认扫描 src/api/，根目录 api/ 需 --app-dir .
❌ user/handler.ts             ← 必须在 api/ 下
✅ src/api/user/handler.ts
```

如需用根目录 `api/`，启动时加 `--app-dir .`。

### 2. handler 没导出方法

```ts
// ❌ 不导出 GET/POST 等,路由存在但 405
export function getUser() { ... }

// ✅ 导出 HTTP 方法名
export function GET() { ... }
```

### 3. tsconfig 没包含 api/

`tsc --noEmit` 不报 handler 内部错误,因为 tsconfig 的 include 漏了 `src/api/**/*.ts`。

### 4. prod 启动失败

```
Error: dist/faapi-routes.js 或 dist/faapi-schema.js 不存在
```

**原因**:没跑 `faapi build` 就用 `faapi start` 启动。

**解决**:先 `faapi build`,再 `faapi start`。

## 检查清单

### CLI 形态

- [ ] `package.json` 有 `@faapi/faapi` 依赖
- [ ] `src/api/` 目录存在,内有 `handler.ts`
- [ ] `tsconfig.json` 的 include 包含 `src/api/**/*.ts`
- [ ] `pnpm dev` 能启动,访问路由返回正常
- [ ] `pnpm typecheck` 通过
- [ ] `pnpm build` 生成 `dist/`(含 `faapi-routes.js` + `faapi-schema.js`)
- [ ] `pnpm start`(即 `faapi start`)能启动

### 集成 Next.js 形态

- [ ] `package.json` 有 `@faapi/faapi` / `@faapi/next` / `next` 依赖
- [ ] `faapi.config.ts` 的 `plugins` 声明 `@faapi/next`
- [ ] `api/` 目录有 faapi 路由,`app/` 目录有 Next.js 页面
- [ ] `faapi` 启动后 `/api/*` 走 faapi,其余走 Next.js
- [ ] 生产部署先 `faapi build` + `next build`

## 相关场景

- [route.md](./route.md) — 写 handler 详细规范
- [config.md](./config.md) — 配置文件
- [debug.md](./debug.md) — 启动失败排查
