---
'@faapi/faapi': minor
'@faapi/agent': minor
---

新增 `AgentDeps` 官方装配工厂 `createAgentDeps`（`@faapi/agent` 导出）——任务内组装 agent / 自组装场景不再逐字段复刻插件工厂的访问器拼装。

- `createAgentDeps({ registries, ctx?, rootDir?, llms?, config?, overrides? })`：从注册表视图 + llms 配置构造完整 `AgentDeps`——注册表访问器透传、`loadToolModule` 桥接、schema 解析器（同一实例服务 tool input 与派发入参）、llms → providers 转换；差异项（`resolveSystemPrompt` 装饰、schema 富化、providers 直传等）经 `overrides` 浅合并叠加
- `registries` 参数取最小结构——`ctx.registries`（AppRegistries）、`taskCtx.registries`（只读视图）、测试设施 `harness.registries` 三种来源均可直传
- 纯装配无副作用：providers Map 与 schema 解析器缓存随 deps 生命周期，进程级复用由调用方负责（插件 setup 调一次天然单例；任务侧建议模块级创建）
- `@faapi/agent` 插件 setup 改经本工厂装配（与任务侧单一实现，行为不变：providers/schema 缓存仍为 setup 闭包级跨请求复用）；空 apiKey 的启动期显性提示保留在插件
