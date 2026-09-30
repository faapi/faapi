---
'@faapi/faapi': minor
---

新增运行时资源目录约定 `src/resources/`：dev 启动时镜像复制到 `.faapi/resources/`（watcher 监听变化单文件增量同步），build 复制到 `dist/resources/`（原样复制，不编译、不被任何扫描器识别）。运行时新增定位入口——HTTP/WS `ctx.resourcesDir`（`<rootDir>/<dist>/resources` 绝对路径）、`app.resourcesDir` / `app.dist`（AppBase 新增字段）、lifecycle 钩子参数 `resourcesDir`；`createTestContext` 新增 `resourcesDir` 选项。
