---
'@faapi/faapi': minor
---

补删 `AppBase.resourcesDir` 字段。6.27.0 已声明删除各上下文的 `resourcesDir` 数据字段（含 AppBase），但源码漏删了 `AppBase` 接口字段与实例赋值，本次补齐口径。资源读取一律走免传参 `readResource()`（读取根在 `createAppBase` 启动时绑定）；定位产物布局用 `app.dist` + 约定子路径（`<dist>/resources`）。
