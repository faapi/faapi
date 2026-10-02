---
'@faapi/faapi': minor
---

删除 `resourcesDir` 各上下文数据字段，读取统一收敛到免传参 `readResource`：

- **删除的字段**：`FaapiContext.resourcesDir` / `WsContext.resourcesDir` / `TaskContext.resourcesDir` / `LifecycleContext.resourcesDir`（onBoot/onReady/onClose 钩子参数）/ `PluginContext.resourcesDir` / `AppBase.resourcesDir`；`createContext` / `createContextFromUrl` 的 `resourcesDir` 参数同步移除
- **留痕说明**：删除公开字段按语义为 breaking（major）；与单 app 强制、agent 自定义 run 移除同先例——业务方读取资源的正道是免传参 `readResource(relativePath, encoding?)`（6.23.0 起），`path.join` + `fs.readFile` 拼字段属无越界防护的绕行读法，字段只会助长它；经维护者决策按 minor 发版
- **迁移**：读资源改用 `readResource('prompts/foo.md')`（读取根 app 启动时自动绑定，越界/符号链接逃逸防护内建）；原来经字段"了解/拼接资源位置"的用例没有等价出口——这是有意收敛
- **不变**：`createTestContext({ resourcesDir })` 选项保留（测试场景绑定全局读取根的唯一入口，ctx 上仍无该字段）；隔离 worker 的读取根播种数据源改为 `TaskQueueDeps.resourcesDir` 内部字段（不进业务上下文）；`copyResources` 的 `src/resources/` 复制机制不变
