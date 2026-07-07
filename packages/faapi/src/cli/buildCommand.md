# buildCommand

一句话概括：CLI 构建命令，编译 TypeScript 到 `.faapi/build/`，并预生成配置产物 + schema 模块 + 路由清单。

## 为什么需要

生产环境需要预编译注入元数据与路由清单，避免运行时 AST 分析与文件扫描开销。`node .faapi/build/main` 直接读取 build 产物启动服务，不扫描文件系统、不现场编译。

## 使用场景

- `faapi build` 命令
- **逐文件编译** `src/**/*.ts` → `.faapi/build/**/*.js`（esbuild，`bundle: false`，与 dev 模式一致）
- **配置文件编译合并** `faapi.config.ts` + `faapi.config.{env}.ts` → `.faapi/build/faapi-config.js`（`compileConfig`，env 在 build 阶段固化）
- 生成 `.faapi/build/**/zod.js`（每个 handler 一个 zod schema 模块）
- 生成 `.faapi/build/faapi-routes.js`（序列化路由清单）

## 构建步骤

构建前先 `compileConfig` + `loadConfig` 读应用行为配置（build 时无 `.faapi/build/` 产物，先生成临时配置产物再读），随后执行 7 步：

1. **扫描源文件**（全量扫描 `src/**/*.ts`，排除测试文件和声明文件，作为编译 entryPoints）
2. **编译 TypeScript**（`compileBuildRoutes`：`bundle: false` 逐文件编译，与 dev 一致，打平 src 前缀）
3. **重新编译并合并配置文件**（`compileConfig`：`faapi.config.ts` + `faapi.config.{env}.ts` → `.faapi/build/faapi-config.js`，确保使用最新源码，深度合并后单文件输出）
4. **扫描路由**（`scanRoutes` 从产物 `.js` import 拿方法名，filePath 保持源码 `.ts`）+ 排序 + 冲突检测
5. **生成 schema 文件**（`generateSchemaFiles` → `.faapi/build/**/zod.js`，AST 从源码 `.ts`）
6. **生成路由清单**（`serializeRoutes` + `writeRoutesModule` → `.faapi/build/faapi-routes.js`）
7. **生成启动入口**（写入 `.faapi/build/main.js`：`import { createProdApp } from '@faapi/faapi'` + `createProdApp()` + `listen()`；`--port` / `--dist` 选项写入 `main.js`，prod 启动时无需再设环境变量）

## 编译模式

`faapi build` 采用 `bundle: false` 逐文件编译，与 `faapi dev` 完全一致，差异仅在 `dist`（build → `.faapi/build/`，dev → `.faapi/dev/`）。

**为什么不用 bundle 模式**：bundle 模式会把 import 的项目模块 inline 进产物,导致 `faapi.config.ts` 中的 `instanceof` 对项目自定义错误类失效（config 和 routes 各自打包出独立的项目类副本）。逐文件编译保证每个源文件对应唯一一份产物,config 和 routes 共享同一运行时对象。

**build 与 dev 的差异**：build 模式额外启用 `define: { 'process.env.NODE_ENV': '"production"' }` + `minifySyntax: true`，在编译期把 `process.env.NODE_ENV` 替换为 `"production"` 并删除 `if (false) {...}` 死分支。两者在 `bundle: false` 下均生效（单文件级别优化）。dev 模式不启用这两个选项，`process.env.NODE_ENV` 在运行时读取（`devCommand` 兜底设为 `'development'`）。

## 产物结构

```
.faapi/build/
├── main.js                   # 启动入口（零入口设计：build 阶段自动生成，import createProdApp + listen）
├── faapi-routes.js           # 路由清单（序列化，含 middlewarePaths）
├── faapi-config.js           # 配置入口产物（import faapi.config.js + 内联 deepMerge）
├── faapi.config.js           # config 源编译产物（保留相对 import 指向项目模块）
├── faapi-helpers.js          # coerce 公用函数（仅当存在 number/boolean 字段时生成）
├── api/hello/handler.js      # 编译后的路由（相对 import 已重写为 .js 后缀）
├── api/hello/zod.js          # zod schema 模块（与 handler.js 同级）
├── api/hello/middlewares.js  # 中间件（独立编译）
├── lib/errors.js             # 项目模块（与 routes 共享，instanceof 跨 config/routes 生效）
└── ...
```

## 启动入口生成

build 阶段最后一步生成 `.faapi/build/main.js`，内容如下：

```js
// 由 faapi build 自动生成，请勿手动编辑
import { createProdApp } from '@faapi/faapi';

const app = await createProdApp();
await app.listen();
```

`node .faapi/build/main` 直接运行此文件启动服务。`@faapi/faapi` 作为运行时依赖保留在 `node_modules` 中（不被 bundle），便于版本升级。

### CLI 选项对 main.js 的影响

`--port` 和 `--dist` 选项会写入 `main.js`，prod 启动时无需再设环境变量：

```bash
faapi build --port 8080 --dist build
# 生成 build/main.js:
# const app = await createProdApp({ dist: 'build' });
# await app.listen(8080);
```

## tsconfig paths 别名处理

编译时由 esbuild onLoad 插件（`createAliasPlugin`）重写别名 specifier 为产物相对路径：

- **编译范围**：全量扫描 `src/**/*.ts` 作为 entryPoints。
- **别名重写**：esbuild `onLoad` 读取源文件后，用正则把 `import/export ... from 'alias'` 和 `import('alias')` 中的别名 specifier 替换为产物相对路径（`.js` 后缀），再交给 esbuild 转译。
- **src 前缀剥离**（`compileConfig` 用）：config 文件位于 rootDir 时,引用 src 内模块的相对 import 被重写为剥离前缀的产物路径,使 config 与 routes 共享同一份模块产物。
- 无 tsconfig / paths 时插件仍生效（相对路径加 `.js` 后缀是 Node ESM 必需）。

## 相关模块

- `compileBuildRoutes.ts` - TypeScript 逐文件编译（与 dev 一致）
- `compileConfig.ts` - 配置文件编译合并（build 时输出 `.faapi/build/faapi-config.js`，两步编译保证 instanceof 跨边界生效）
- `loadConfig.ts` - 读应用行为配置
- `generateSchemaFiles.ts` - 为每个 handler 生成 zod.js
- `generateRoutes.ts` - 序列化路由清单与水合还原
- `scanRoutes.ts` - 扫描路由
- `readTsconfig.ts` - 读取 tsconfig paths 配置
- `resolveAlias.ts` - 按 paths 配置解析别名 specifier
