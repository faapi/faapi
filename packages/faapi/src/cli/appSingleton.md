# appSingleton

一句话概括：faapi app 的进程级单例（globalThis 承载）与默认优雅停机信号处理，从 createAppCore 拆出。

## 为什么需要

两个与编排无关的进程级关切：① Next.js 16 Turbopack dev runtime 与主进程 module cache 是两套独立缓存，`getApp()` 必须经 `Symbol.for` + `globalThis` 跨实例共享；② SIGTERM/SIGINT 的默认停机入口只需注册一次（进程级，防测试多次 listen 堆积监听器）。

## 使用场景

- `createAppBase` 末尾 `setCurrentApp(app)`，`close()` 末尾按指向清理
- 业务方经 `@faapi/faapi` 的 `getApp()` 在 Next.js RSC 等场景拿实例
- `listen` 成功后 `registerDefaultShutdownHandlers()`

## 行为约定

- 单例只指向「最近一次创建且未关闭的 app」；`setCurrentApp(null)` 仅在测试里直接用，业务侧由 close 内部按「仍指向自己」守卫清理
- 信号处理写入 globalThis 标记防重装；收到信号关闭当前单例后 `process.exit(0)`
- AppBase 为 type-only 导入（编译期擦除），本模块与 createAppCore 无运行时循环

## 相关模块

- `createAppCore.ts` — 唯一写入方（编排主流程）
- `../../server/createServer.md` — app.close 驱动的 server drain
