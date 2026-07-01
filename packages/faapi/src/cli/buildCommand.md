# buildCommand

一句话概括：CLI 构建命令，编译 TypeScript 到 `dist/`，并预生成 schema 模块 + 路由清单。

## 为什么需要

生产环境需要预编译注入元数据与路由清单，避免运行时 AST 分析与文件扫描开销。start 命令直接读取 build 产物，无需 tsx，不扫描文件系统。

## 使用场景

- `faapi build` 命令
- 编译 `src/**/*.ts` → `dist/**/*.js`（esbuild，含别名重写）
- 生成 `dist/faapi-schema.js`（schema 校验模块）
- 生成 `dist/faapi-routes.js`（序列化路由清单）
- 生成 `faapi-types.ts`（RPC 类型文件，可选）

## 构建步骤

1. 编译 TypeScript（`compileRoutes`：esbuild 逐文件编译 `src/**/*.ts` → `dist/**/*.js`，保持目录结构，含别名重写）
2. 扫描路由（`scanRoutes` 从产物 `.js` import 拿方法名，filePath 保持源码 `.ts`）
3. 生成类型文件（`generateTypes`）
4. 生成 schema 模块（`generateSchemaFile` → `dist/faapi-schema.js`，AST 从源码 `.ts`）
5. 生成路由清单（`serializeRoutes` + `writeRoutesModule` → `dist/faapi-routes.js`）

## 产物结构

```
dist/
├── faapi-routes.js      # 路由清单（序列化，含 middlewarePaths）
├── faapi-schema.js      # schema 校验模块
├── src/api/hello/handler.js  # 编译后的路由
└── ...
```

## tsconfig paths 别名处理

编译时由 esbuild onLoad 插件（`createAliasPlugin`）重写别名 specifier 为产物相对路径：

- **编译范围**：扫描整个 `appDir` 下的 `.ts`（排除 `*.test.ts` / `*.e2e.test.ts` / `*.d.ts`），覆盖路由、中间件、以及被别名引用的依赖文件。
- **别名重写**：esbuild `bundle: false` 模式下 `onResolve` 不触发，改用 `onLoad` 读取源文件后，用正则把 `import/export ... from 'alias'` 和 `import('alias')` 中的别名 specifier 替换为产物相对路径（`.js` 后缀），再交给 esbuild 转译。
- 无 tsconfig / paths 时插件不启用，无副作用。

## 相关模块

- `compileRoutes.ts` - TypeScript 编译
- `generateSchema.ts` - 生成 schema 校验模块
- `generateRoutes.ts` - 序列化路由清单与水合还原
- `scanRoutes.ts` - 扫描路由
- `readTsconfig.ts` - 读取 tsconfig paths 配置
- `resolveAlias.ts` - 按 paths 配置解析别名 specifier
