---
'@faapi/faapi': major
'@faapi/agent': major
---

# 注册表实例化（方案 A）：tool/agent/skill/agentHandle 注册表从进程级全局单例改为 app 实例级状态

## 变更

每个 app（`createAppBase`）现在创建并持有独立的注册表集合（`AppRegistries`），水合、请求链路、插件、lifecycle 钩子均读写 app 自己的实例，`app.close()` 随实例销毁。多 app 同进程互不串台——此前模块级全局单例 + hydrate 整体替换语义下，后创建的 app 会覆盖先创建的 app 的清单，跨项目数据串台且无报错。

## 破坏性变更

- **app 不再填充全局单例**：启动后 `getTool()` / `listAgents()` 等全局函数返回默认实例（空）——请改用 `app.registries`（`AppBase` 新增字段）或 `ctx.registries`
- **`app.close()` 只清自己的实例**：不再调用全局 `clearToolRegistry()` 等
- **业务方 skill 灌入路径变更**：`lifecycle.onReady(ctx)` 的 `ctx` 新增 `registries` 字段，请改用 `ctx.registries.skill.hydrate/upsert`——经全局 `hydrateSkillRegistry` 灌入的数据不会进入 app 的请求链路
- **`PluginContext` 新增必填 `registries`**：自定义插件若实现了 PluginContext 形状的 mock/适配需补此字段
- **`@faapi/agent` 插件**：工厂注册与 deps 改走 `ctx.registries`（app 实例）——模拟插件 setup 的测试需改用真实 `createAppRegistries()`

## 新增 API

- `createAppRegistries()`：创建一套 app 级注册表
- `AppRegistries` / `ToolRegistry` / `AgentRegistry` / `SkillRegistry` / `AgentHandleStore` 类型
- `AppBase.registries` / `AppContext.registries` / `FaapiContext.registries?` / `LifecycleContext.registries` / `PluginContext.registries`
- `@faapi/faapi/testing` 的 `CreateTestContextOptions.registries?`

## 兼容保留

四个注册表模块的全局函数（`getTool` / `hydrateToolRegistry` / `getAgent` / `listAgents` / `hydrateSkillRegistry` / `upsertSkill` / `registerAgentHandleFactory` 等）保留，作为**默认实例**的便捷访问器（编程式直调 / 单元测试场景）。注意默认实例与 app 实例相互独立。
