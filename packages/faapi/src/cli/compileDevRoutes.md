# compileDevRoutes

一句话概括：dev 模式逐文件编译 TypeScript 源码到 `.faapi/` 产物（`bundle: false`），支持全量编译与增量编译，配合原子写避免 watch 期间运行时读到半成品产物。（实现由 [compileSourceFiles](./compileSourceFiles.md) 提供，本模块为 dev 模式薄封装：仅 `atomicWrite` / `production` 选项差异）

## 为什么需要

dev 模式需要把 `src/**/*.ts` 编译为 `.js` 供运行时 `import` 加载。采用逐文件编译（`bundle: false`）而非 bundle 模式，是为了保证 `faapi.config.ts` 中的 `instanceof` 对项目自定义错误类跨 config/routes 边界生效——bundle 模式会把 import 的项目模块 inline 进产物，导致 config 和 routes 各自打包出独立的项目类副本，运行时对象不同一。

dev 模式特有需求：
- **watch 增量编译**：只重编译变化的文件，启动快
- **原子写**：watch 期间运行时仍在处理 HTTP 请求，esbuild 非原子写会让 `import()` 读到写一半的产物（alias 未重写完 → `Cannot find package '@/lib'` → 500）。原子写（临时文件 + rename）保证 rename 前看到旧完整文件、rename 后看到新完整文件，无半成品窗口

## 使用场景

- `faapi dev` 启动：按需编译模式下不再全量调用，仅在 `ensureCompiled` 单文件编译时调用
- `watcher` 增量编译：文件变化时传入变化文件列表
- `compileOnDemand.ensureCompiled`：首次请求 handler.js 不存在或 stale 时单文件编译

## dev 原子写（`write: false` + rename）

启用 esbuild `write: false`，拿到 `outputFiles` 后自行原子写（写临时文件 + `rename`）：

```ts
const tmp = `${file.path}.tmp-${process.pid}-${Math.random()...}`;
await fs.promises.writeFile(tmp, file.contents);
await fs.promises.rename(tmp, file.path);  // POSIX 原子
```

**为什么仅 dev 需要**：build 模式是一次性编译，运行时不并发，用 esbuild 默认写即可。

## 统一编译模式：逐文件编译（`bundle: false`）

每个 `.ts` 独立编译为 `.js`，esbuild 不分析 import 关系。

- 产物打平 `src/` 前缀：`src/api/hello/handler.ts` → `<dist>/api/hello/handler.js`（`outbase` 设为 `src`）
- 别名在编译时重写为相对路径（`aliasPlugin`），运行时无需 loader
- tree shaking 不可用（`bundle: false` 不分析跨文件引用图）——符合设计意图，保留所有 export 让 config/routes 共享同一运行时对象

**与 `compileBuildRoutes` 的差异**：仅 `dist` 不同（dev 为 `.faapi`，build 为 `dist`），编译逻辑一致。build 额外启用 `define` + `minifySyntax` 做编译期常量替换与死分支删除。

## 相关模块

- [compileBuildRoutes](./compileBuildRoutes.md) — build 模式逐文件编译（与 dev 一致，仅 dist 不同 + 额外 define/minifySyntax）
- [compileOnDemand](./compileOnDemand.md) — `ensureCompiled` 内部调本模块单文件编译
- [watcher](./watcher.md) — 增量编译变化的文件
- [devCommand](./devCommand.md) — dev 命令入口
- [aliasPlugin](./aliasPlugin.md) — 别名重写插件
- [readTsconfig](./readTsconfig.md) — 读取 tsconfig paths 配置
