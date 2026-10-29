# registries

一句话概括：app 级注册表集合——tool / agent / agentHandle / taskHandle / llm / appEvents 的实例化实现，每个 app 持有独立一套，随 app 创建与销毁。

## 为什么需要

注册表的生命周期必须与 app 实例一致：

- 同进程可能有两个 app（测试 / 嵌入 / 多租户），注册表若游离在 app 之外，清单无法区分归属
- app `close()` 时注册表必须随之清理，不残留

实例化后注册表挂在 app 上：多 app 天然隔离，`app.close()` 清自己的实例，互不影响。

## 使用场景

- `createAppBase`：创建 `AppRegistries` → 水合 faapi-tools.js / faapi-agents.js 到实例 → 经 `FaapiContext.registries` / `PluginContext.registries` / `LifecycleContext.registries` 传递
- `@faapi/agent` 插件经 `ctx.registries.agentHandle.register(...)` 注册工厂，deps 读同套实例
- `@faapi/agent` 插件经 `ctx.registries.llm.register(...)` 注册轻量补全通道（`LlmChannelStore`，存实例本身而非工厂——channel 与请求上下文无关），handler 的 `llm` 注入参数与任务执行上下文（`taskCtx.llm`）读取
- `@faapi/agent` 插件经 `overrides.emitAppEvent` 把 `ctx.registries.appEvents.emit` 注入 agent deps——`agent:root-input` / `agent:input` 事件恒发射到 app 自己的总线（[appEventBus](../events/appEventBus.md)，业务方经 `getApp().on(...)` 订阅，`app.close()` 时 `clear()`）

## 默认实例与全局函数

`defaultRegistries` 是模块级默认实例；toolRegistry / agentRegistry / agentHandle 模块的同名全局函数（`getTool` / `listAgents` / `registerAgentHandleFactory` 等）保留为**默认实例的便捷访问器**，供编程式直调 / 单元测试 / 无 app 上下文场景。

注意：默认实例与 app 实例相互独立——经全局函数水合的数据不会出现在任何 app 的请求链路中；多 app 场景下默认实例无隔离语义（等同旧全局行为）。框架自身链路不读写默认实例。

## 任务侧只读视图（TaskRegistriesView）

`createTaskRegistriesView(registries)` 把 AppRegistries 投影为**只读视图**（agent 的 get/getEntry/list/asTool/resolve* + tool 的 get/list），注入任务执行上下文（`TaskContext.registries`）——任务执行侧不在 handler 请求链路上，拿不到 `FaapiContext.registries`；视图刻意不暴露 `hydrate`/`clear` 写接口：任务不是注册表的所有者。

轻量补全通道不走该视图：`TaskContext.llm` 由任务队列从 `AppRegistries.llm` 单独接线（惰性读 store）。

## 相关模块

- `toolRegistry.ts` / `agentRegistry.ts` / `agentHandle.ts` - 默认实例便捷访问器（委托层）
- `llmTypes.ts` - 轻量补全通道规范类型（`LlmComplete` / `LlmCompleteOptions`，实现在 `@faapi/agent`）
- `../cli/createAppCore.md` - 创建与水合时机
- `agentRegistry.md` - agent 注册表全局访问器
