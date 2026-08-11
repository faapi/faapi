---
'@faapi/faapi': patch
---

修复 `getApp()` 在 Next.js 16 + `@faapi/next` 集成场景下抛 "No app instance" 的问题（dev 和生产模式都受影响）。

将 app 单例从模块级变量改为 `globalThis` + `Symbol.for('faapi.app.instance')` 存储。

**根因**：Next.js 16 默认使用 Turbopack 作为 `next dev` 和 `next build` 的 bundler。Turbopack runtime 与主进程的 Node.js 原生 module cache 是两套独立缓存——即使配置了 `serverExternalPackages: ['@faapi/faapi']`，RSC chunk 加载的 `@faapi/faapi` 仍是另一个模块实例，模块级变量 `currentApp` 无法跨实例共享，导致 RSC 中 `getApp()` 读到的永远是 `null`。

此问题在 dev 模式（`faapi dev`）和生产模式（`node dist/main` + `next build`）下都存在，只要应用通过 Next.js RSC 调用 `getApp()` + `app.inject()` 就会触发。

用 `globalThis` 存储后，无论通过哪个模块实例加载，都能读到同一个 app 引用，使 `@faapi/next` 插件集成的 RSC 场景在 dev/prod 下都正常工作。
