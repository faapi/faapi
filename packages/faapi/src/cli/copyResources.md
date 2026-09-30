# copyResources

一句话概括：把约定目录 `src/resources/` 下的运行时静态文件原样复制进产物目录（dev `.faapi/resources/`、build `dist/resources/`），并提供运行时定位函数。

## 为什么需要

handler 运行在 Node.js 里，业务方经常需要读项目内的静态文件（prompt 模板、JSON 配置、证书、字体等）。但编译链路只处理 `.ts`——非代码文件不会进入 `.faapi/` 或 `dist/`，产物目录结构又打平了 `src/` 前缀，业务方无法用稳定的相对路径定位源码侧文件；生产部署只带 `dist/` 时源码目录根本不存在。框架需要一个约定：资源文件放 `src/resources/`，dev/build 两个阶段负责复制进产物，运行时提供可靠的定位入口。

## 使用场景

- 业务方把文件放 `src/resources/` 下（任意子目录结构、任意扩展名）
- `faapi dev` 启动时镜像复制到 `.faapi/resources/`；watcher 监听 `src/resources/` 下任意文件的新增/修改/删除，单文件增量同步到产物
- `faapi build` 在 dist 清空后复制到 `dist/resources/`（emptyOutDir 保证无 stale）
- 运行时通过 `ctx.resourcesDir`（HTTP/WS 链路）或 `app.resourcesDir` / lifecycle 钩子参数拿到 resources 根目录绝对路径，`path.join` 后自行 `fs.readFile`

## 约定与边界

- **原样复制**：`src/resources/` 下的所有文件（含 `.ts`）按二进制原样复制，不编译、不注入、不被路由/tool/agent/task 扫描（`collectSourceFiles` 的 glob 已排除该目录）。在 resources 里放 `handler.ts` 不会成为路由。
- **产物布局**：打平 `src/` 前缀——`src/resources/prompts/foo.md` → `<dist>/resources/prompts/foo.md`，与 handler 产物布局一致。
- **镜像语义**：`copyResources` 先删 `<dist>/resources` 再递归复制；`src/resources/` 不存在时跳过（返回 `false`，无该目录的项目零负担，产物中也不产生 resources 目录）。
- **增量同步是文件级的**：watcher 只处理文件的新增/修改（`copyResourceFile`）与删除（`removeResourceFile`）；空目录与目录级删除（`unlinkDir`）不处理——业务读取以文件为单位，产物里残留空目录无业务影响。
- **源文件已删除时 `copyResourceFile` 跳过复制**（change 与 unlink 的竞态：文件删除后到达的 change 事件不做无用复制，产物清理由 unlink 事件负责）。
- **任务隔离 worker 不注入**：taskCtx 无 resourcesDir（快照语义暂不携带路径，第一版边界；任务内可经 `process.cwd()` + `FAAPI_DIST` 约定自行定位）。
- **testing 直调**：`createTestContext` 构造的 ctx 默认无 `resourcesDir`（`undefined`），可经选项显式传入。

## 相关模块

- [devCommand](./devCommand.ts) / [buildCommand](./buildCommand.ts) — 启动/构建流程中调用 `copyResources`
- [watcher](./watcher.ts) — dev 文件事件分流：resources 路径走增量复制/删除，不进编译调度器
- [compileSourceFiles](./compileSourceFiles.ts) — `collectSourceFiles` 的 glob ignore 排除 `src/resources/**`
- [createAppCore](./createAppCore.ts) — `AppBase.resourcesDir` / `AppBase.dist` 与 lifecycle 钩子参数
- [createContext](../runtime/createContext.ts) — `ctx.resourcesDir` 挂载
- [prodPaths](../utils/prodPaths.ts) — `isInsideDir` 做源文件路径归属校验
