---
'@faapi/faapi': patch
---

路由匹配索引化：每请求的 O(n) 线性扫描改为静态路由 O(1) Map 命中 + 动态路由按序扫描（索引按清单数组身份 WeakMap 缓存，`reloadRoutes` 整体替换清单后自动失效，匹配语义与原实现完全等价）。`findAllowedMethods`（405 反查）同步索引化，扫描器/探活探测的高频 404 场景开销显著下降。
