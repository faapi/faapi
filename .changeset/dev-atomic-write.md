---
'@faapi/faapi': patch
---

修复 dev watch 模式下偶发 `Cannot find package '@/lib'` 500 错误。

## 问题

watch 模式下快速连续修改文件,偶发请求返回 500:
```
Failed to load route module: Cannot find package '@/lib' imported from ...handler.ts
```

## 根因

`compileDevRoutes` 用 esbuild 默认写文件(非原子)。`rebuildRoutes` 调 `compileDevRoutes` 期间,Node 主线程事件循环仍处理 HTTP 请求。esbuild 写文件(非原子)时,运行时 `loadRouteModule` 的 `import()` 可能读到写一半的产物(alias 未重写完)→ `Cannot find package '@/lib'` → 500。

## 修复

`compileDevRoutes` 启用 esbuild `write: false`,拿到 `outputFiles` 后自行**原子写**(写临时文件 + `rename`)。`rename` 在同一文件系统上是原子的(POSIX),HTTP 请求要么看到旧完整文件,要么看到新完整文件,无半成品窗口。

仅 dev 需要(`compileBuildRoutes` 是 build 一次性编译,运行时不并发,用 esbuild 默认写即可)。
