# 命令行工具

提供 dev 和 build 命令，是 faapi 框架的入口。

## 模块

| 模块 | 说明 |
| --- | --- |
| [index.ts](./index.ts) | CLI 入口，调用 startCommand |
| [parseArgs.ts](./parseArgs.ts) | 参数解析，基于 cac |
| [normalizePatterns.ts](./normalizePatterns.ts) | pattern 标准化：逗号分隔→数组 |
| [startCommand.ts](./startCommand.ts) | 启动：dev/prod 自动判断，加载 schema→启动服务→watch(dev)→MCP |
| [buildCommand.ts](./buildCommand.ts) | 构建：扫描路由→类型生成→schema 模块生成→TypeScript 编译 |
| [generateTypes.ts](./generateTypes.ts) | 类型文件生成：FaapiRoutes namespace + FaapiClient interface |
| [generateSchema.ts](./generateSchema.ts) | schema 生成：从路由提取类型并生成校验函数，写入/读取 faapi-schema.js |
| [watcher.ts](./watcher.ts) | dev watch：文件变化全量重建 schema + 路由 |

## CLI 选项

| 选项 | 说明 | 默认值 |
| --- | --- | --- |
| `--port` | 服务端口（env: PORT） | 3000 |
| `--app-dir` | app 目录 | `app` |
| `--cors` / `--no-cors` | 启用/禁用 CORS | dev 模式默认启用 |
| `--static` / `--no-static` | 静态文件目录 | 无 |
| `--types` | 类型文件输出路径 | 无 |

## 启动流程

### dev 模式（默认）

```
parseArgs → scanRoutes → sortRoutes → extractSchemasForRoutes → schemaRegistry.loadManifest
         → startServer → startWatcher（全量重建 schema）→ startMcpServer（按条件）
```

### prod 模式（NODE_ENV=production 且 dist/faapi-schema.js 存在）

```
parseArgs（patterns/appDir 自动指向 dist）→ scanRoutes（.js）→ sortRoutes
         → readManifestFile → schemaRegistry.loadManifest
         → startServer → startMcpServer（按条件）
```

dev 和 prod 共用 createServer / handleRequest / validateInput，差异仅在 schema 来源、文件类型、是否启动 watch。

## build 流程

```
scanRoutes → sortRoutes → generateTypes → extractSchemaEntries → writeSchemaModule
           → compileTypeScript
```

产物：
- `dist/api/**/handler.js` — 编译后的路由文件
- `dist/faapi-schema.js` — schema 模块（prd 运行时类型校验的数据来源）
- `faapi-types.ts` — RPC 类型文件（可选）

## 相关模块

- [router](../router/README.md)：路由扫描与排序
- [server](../server/README.md)：HTTP 服务启动
- [@faapi/schema](../../../schema/)：路由 schema 扩展包，通过 MCP 暴露路由信息给 LLM
- [validator](../validator/README.md)：输入校验（消费 schema）
