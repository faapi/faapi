# buildCommand

一句话概括：CLI 构建命令，编译 TypeScript 到 `dist/`，并预生成配置产物 + schema 模块 + 路由清单。

## 为什么需要

生产环境需要预编译注入元数据与路由清单，避免运行时 AST 分析与文件扫描开销。`node dist/main` 直接读取 build 产物启动服务，不扫描文件系统、不现场编译。

## 使用场景

- `faapi build` 命令
- **bundle 模式编译** `src/**/*.ts` → `dist/**/*.js`（esbuild，从 entries 出发跟随 import 链，tree shaking + splitting 共享依赖提取为 chunk）
- **配置文件编译合并** `faapi.config.ts` + `faapi.config.{env}.ts` → `dist/faapi-config.js`（`compileConfig`，env 在 build 阶段固化）
- 生成 `dist/**/zod.js`（每个 handler 一个 zod schema 模块）
- 生成 `dist/faapi-routes.js`（序列化路由清单）

## 构建步骤

构建前先 `compileConfig` + `loadConfig` 读应用行为配置，环境变量读 `appDir`/`patterns`（build 时无 `dist/` 产物，先生成临时配置产物再读），随后执行 7 步：

1. **收集 bundle entries**（`collectBundleEntries`：handler.ts + middlewares.ts，去重）
2. **编译 TypeScript**（`compileBuildRoutes`：bundle 模式 + `splitting` + `define: { 'process.env.NODE_ENV': '"production"' }` + `minifySyntax`，tree shaking + 死分支删除）
3. **重新编译并合并配置文件**（`compileConfig`：`faapi.config.ts` + `faapi.config.{env}.ts` → `dist/faapi-config.js`，确保使用最新源码，深度合并后单文件输出）
4. **扫描路由**（`scanRoutes` 从产物 `.js` import 拿方法名，filePath 保持源码 `.ts`）+ 排序 + 冲突检测
5. **生成 schema 文件**（`generateSchemaFiles` → `dist/**/zod.js`，AST 从源码 `.ts`）
6. **生成路由清单**（`serializeRoutes` + `writeRoutesModule` → `dist/faapi-routes.js`）
7. **生成启动入口**（写入 `dist/main.js`：`import { createProdApp } from '@faapi/faapi'` + `createProdApp()` + `listen()`）

## bundle 模式 entries 收集

`collectBundleEntries` 收集入口文件（绝对路径，去重）：

- **handler.ts**：通过 `patterns` 扫描源码（与 `scanRoutes` 同一范围），过滤文件名以 `handler.ts` 结尾的文件。
- **middlewares.ts**：扫描 `appDir` 下所有 `**/middlewares.ts`（中间件文件按目录约定自动加载，handler 不直接 import，必须作为独立 entry 才能被运行时按 `middlewarePaths` 动态 import）。

框架采用零入口设计——用户无需编写 `main.ts`，build 阶段自动生成 `dist/main.js` 启动入口。

其他 .ts 文件（如 `utils.ts`）不需作为 entry：bundle 模式下 esbuild 会跟随 import 链自动把它们 bundle 进用到的 entry，或通过 splitting 提取为 chunk。

## 产物结构

```
dist/
├── main.js                   # 启动入口（零入口设计：build 阶段自动生成，import createProdApp + listen）
├── faapi-routes.js           # 路由清单（序列化，含 middlewarePaths）
├── faapi-config.js           # 配置文件（faapi.config.ts + env 合并产物，自包含 deepMerge 逻辑）
├── chunk-<hash>.js           # 共享依赖 chunk（splitting 自动提取，无共享依赖时不生成）
├── api/hello/handler.js      # 编译后的路由（import 路径已重写指向 chunk）
├── api/hello/zod.js          # zod schema 模块（与 handler.js 同级）
├── api/hello/middlewares.js  # 中间件（作为独立 entry 编译）
└── ...
```

## 启动入口生成

build 阶段最后一步生成 `dist/main.js`，内容如下：

```js
// 由 faapi build 自动生成，请勿手动编辑
import { createProdApp } from '@faapi/faapi';

const app = await createProdApp();
await app.listen();
```

`node dist/main` 直接运行此文件启动服务。`@faapi/faapi` 作为运行时依赖保留在 `node_modules` 中（不被 bundle），便于版本升级。

## tree shaking 与 define

`faapi build` 启用 bundle 模式 + splitting + define + minifySyntax：

- **`define: { 'process.env.NODE_ENV': '"production"' }`**：编译时把 `process.env.NODE_ENV` 替换为 `'production'` 字面量，使 `if ("production" !== 'production')` 变为 `if (false)`。
- **`minifySyntax: true`**：删除 `if (false) {...}` 等死分支（不缩短变量名、不压缩空白，保留可读性）。define 只做替换，minifySyntax 才做删除，两者配合完成完整的 dead code elimination。
- **跨文件 dead code elimination**：`utils.ts` 里没被任何 entry import 的 export 会被删除。
- **splitting**：共享依赖（如 `utils.ts` 被多个 handler 引用）自动提取为 `chunk-<hash>.js`，被各 entry 复用，避免重复打包。

业务代码示例：

```ts
// src/utils.ts
export function usedHelper() { ... }      // 被 handler import → 保留
export function unusedHelper() { ... }    // 没被任何 handler import → 删除

// src/api/user/handler.ts
export function GET() {
  if (process.env.NODE_ENV !== 'production') {
    console.log('debug');                  // define → if (false) → minifySyntax → 删除
  }
  return usedHelper();
}
```

dev 模式不启用 bundle，保持 `bundle: false` 逐文件编译（启动快、增量编译），运行时 `process.env.NODE_ENV` 由 `devCommand` 兜底设为 `'development'`。

## tsconfig paths 别名处理

编译时由 esbuild onLoad 插件（`createAliasPlugin`）重写别名 specifier 为产物相对路径：

- **编译范围**：bundle 模式下由 entries 决定（esbuild 跟随 import 链自动覆盖所有依赖文件）。
- **别名重写**：esbuild `onLoad` 读取源文件后，用正则把 `import/export ... from 'alias'` 和 `import('alias')` 中的别名 specifier 替换为产物相对路径（`.js` 后缀），再交给 esbuild 转译。
- 无 tsconfig / paths 时插件不启用，无副作用。

## 相关模块

- `compileRoutes.ts` - TypeScript 编译
- `compileConfig.ts` - 配置文件编译合并（build 时输出 `dist/faapi-config.js`）
- `loadConfig.ts` - 读应用行为配置
- `generateSchemaFiles.ts` - 为每个 handler 生成 zod.js
- `generateRoutes.ts` - 序列化路由清单与水合还原
- `scanRoutes.ts` - 扫描路由
- `readTsconfig.ts` - 读取 tsconfig paths 配置
- `resolveAlias.ts` - 按 paths 配置解析别名 specifier
