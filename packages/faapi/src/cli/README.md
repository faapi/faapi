# 命令行工具

提供 dev / start / build 三个命令，是 faapi 框架的入口。参考 Next.js 实现，dev 和 build 都先编译 TypeScript 到中间产物，运行时只加载 `.js`。

## 命令体系

| 命令 | 模式 | 行为 |
|------|------|------|
| `faapi` / `faapi dev` | dev | esbuild 编译 `.ts` → `.faapi/dev/*.js`，加载产物启动，watch（增量编译 + 热替换路由），预生成 schema |
| `faapi start` | prd | 加载 `dist/faapi-routes.js` 路由清单 + `dist/faapi-schema.js` schema，不 watch |
| `faapi build` | 构建 | 编译 `.ts` → `dist/*.js` + 生成 `dist/faapi-routes.js` + `dist/faapi-schema.js`，不启动服务器 |

启动模式由命令词决定，不再依赖 `NODE_ENV=production`。`NODE_ENV`/`FAAPI_ENV` 仅用于加载环境配置文件。

## 模块

| 模块 | 说明 |
| --- | --- |
| [index.ts](./index.ts) | CLI 入口，分发 build/dev/start 命令，dev/start 模式注册 tsx（仅加载 faapi.config.ts） |
| [parseArgs.ts](./parseArgs.ts) | 参数解析，识别 dev/start 命令词，基于 cac |
| [normalizePatterns.ts](./normalizePatterns.ts) | pattern 标准化：逗号分隔→数组 |
| [startCommand.ts](./startCommand.ts) | 启动：按 mode 走 dev/start 分支，dev 编译+扫描+生成 schema，start 读清单+水合 |
| [buildCommand.ts](./buildCommand.ts) | 构建：编译 TypeScript → 扫描路由 → 类型生成 → schema 模块 → 路由清单 |
| [compileRoutes.ts](./compileRoutes.ts) | 统一编译模块：esbuild 编译 `.ts` 到指定目录（dev→`.faapi/dev/`，build→`dist/`） |
| [generateTypes.ts](./generateTypes.ts) | 类型文件生成：FaapiRoutes namespace + FaapiClient interface |
| [generateSchema.ts](./generateSchema.ts) | schema 生成：从路由提取类型并生成校验函数，写入/读取 faapi-schema.js |
| [generateRoutes.ts](./generateRoutes.ts) | 路由清单：build 时序列化为 faapi-routes.js，start 时 import + 水合（加载中间件） |
| [watcher.ts](./watcher.ts) | dev watch：监听 appDir，增量编译 + 全量扫描 + 热替换路由 |

## CLI 选项

| 选项 | 说明 | 默认值 |
| --- | --- | --- |
| `--port` | 服务端口（env: PORT） | 3000 |
| `--app-dir` | app 目录 | `src` |
| `--cors` / `--no-cors` | 启用/禁用 CORS | 默认启用 |
| `--static` / `--no-static` | 静态文件目录 | 无 |
| `--types` | 类型文件输出路径 | 无 |
| `--config` | 配置文件路径 | 无 |

## 启动流程

### dev 模式（`faapi` / `faapi dev`）

```
parseArgs(mode=dev) → compileRoutes(src/**/*.ts → .faapi/dev/**/*.js)
  → scanRoutes(import 产物 .js, filePath 保持源码 .ts) → sortRoutes
  → generateSchemaFile(.faapi/dev/faapi-schema.js) → loadSchemaToRegistry(remap=false)
  → startServer → startWatcher（增量编译 + 热替换路由）
```

### start 模式（`faapi start`）

```
parseArgs(mode=start) → import dist/faapi-routes.js → hydrateRoutes（按 middlewarePaths 加载中间件）
  → sortRoutes → loadSchemaToRegistry(dist/faapi-schema.js, remap=true)
  → startServer
```

start 不编译、不扫描文件系统：路由清单由 build 时序列化生成，启动时 import 读取并水合
（按 middlewarePaths 重新加载中间件文件，还原洋葱模型与注入器）。

dev 和 start 共用 createServer / handleRequest / validateInput，差异仅在产物目录（`.faapi/dev` vs `dist`）、是否编译、是否启动 watch。

## build 流程

```
parseBuildArgs → compileRoutes(src/**/*.ts → dist/**/*.js)
  → scanRoutes(import 产物 .js) → sortRoutes → generateTypes
  → generateSchemaFile(dist/faapi-schema.js)
  → serializeRoutes + writeRoutesModule(dist/faapi-routes.js)
```

产物：
- `dist/src/api/**/handler.js` — 编译后的路由文件
- `dist/faapi-schema.js` — schema 模块（start 模式运行时类型校验的数据来源）
- `dist/faapi-routes.js` — 序列化路由清单（start 模式路由来源，含 middlewarePaths）
- `faapi-types.ts` — RPC 类型文件（可选）

## 相关模块

- [router](../router/README.md)：路由扫描与排序
- [server](../server/README.md)：HTTP 服务启动
- [@faapi/schema](../../../schema/)：路由 schema 扩展包，通过 MCP 暴露路由信息给 LLM
- [validator](../validator/README.md)：输入校验（消费 schema）
