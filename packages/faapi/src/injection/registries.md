# registries

一句话概括：app 级注册表集合——tool / agent / skill / agentHandle 四张表的实例化实现，每个 app 持有独立一套，随 app 创建与销毁。

## 为什么需要

注册表此前是模块级全局单例 + hydrate 整体替换语义，生命周期与 app 实例脱钩：

- 同进程两个 app（测试 / 嵌入 / 多租户），后创建的 app 水合时**覆盖**先创建的 app 的清单——先创建的 app 请求拿到的是别人的 tool/agent，且无任何报错
- 任一 app close 会清空全部注册表（已先前的所有权守卫缓解，但覆盖端无解）

实例化后注册表挂在 app 上：多 app 天然隔离，`app.close()` 清自己的实例，互不影响。

## 使用场景

- `createAppBase`：创建 `AppRegistries` → 水合 faapi-tools.js / faapi-agents.js 到实例 → 经 `FaapiContext.registries` / `PluginContext.registries` / `LifecycleContext.registries` 传递
- 业务方 plugin 在 `lifecycle.onReady(ctx)` 中经 `ctx.registries.skill` 灌入 DB skill（推荐路径，与 app 生命周期绑定）
- `@faapi/agent` 插件经 `ctx.registries.agentHandle.register(...)` 注册工厂，deps 读同套实例

## 默认实例与全局函数

`defaultRegistries` 是模块级默认实例；toolRegistry / agentRegistry / skillRegistry / agentHandle 四个模块的同名全局函数（`getTool` / `listAgents` / `hydrateSkillRegistry` / `registerAgentHandleFactory` 等）保留为**默认实例的便捷访问器**，供编程式直调 / 单元测试 / 无 app 上下文场景。

注意：默认实例与 app 实例相互独立——经全局函数水合的数据不会出现在任何 app 的请求链路中；多 app 场景下默认实例无隔离语义（等同旧全局行为）。框架自身链路不读写默认实例。

## 相关模块

- `toolRegistry.ts` / `agentRegistry.ts` / `skillRegistry.ts` / `agentHandle.ts` - 默认实例便捷访问器（委托层）
- `../cli/createAppCore.md` - 创建与水合时机
- `agentRegistry.md` - 与 skillRegistry 的隔离约定（实例化后不变）
