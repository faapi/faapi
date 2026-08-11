---
'@faapi/faapi': patch
---

修复 `getApp()` 在 Next.js 16 + `@faapi/next` dev 模式下抛 "No app instance" 的问题。

将 app 单例从模块级变量改为 `globalThis` + `Symbol.for('faapi.app.instance')` 存储。

**根因**：Next.js 16 默认用 Turbopack 作为 `next dev` 的 bundler，Turbopack dev server runtime 与主进程的 Node.js 原生 module cache 是两套独立缓存。即使配置了 `serverExternalPackages: ['@faapi/faapi']`，RSC chunk 在运行时仍通过 Turbopack runtime 加载 `@faapi/faapi`，得到的是另一个模块实例，模块级变量 `currentApp` 无法跨实例共享，导致 RSC 中 `getApp()` 读到的永远是 `null`。

**影响范围**：仅 dev 模式（`faapi dev` + `next dev: true`）。生产模式（`node dist/main` + `next build`）不受影响——`next build` 虽然用 Turbopack 编译，但产物是普通 JS 文件，运行时通过 Node.js 原生 `require` 加载，external 包命中主进程 module cache，与主进程是同一个模块实例。

用 `globalThis` 存储后，无论通过哪个模块实例加载，都能读到同一个 app 引用，使 `@faapi/next` 插件集成的 RSC 场景在 dev 模式下正常工作（生产模式本来就不受影响，此修复对生产模式无副作用）。
