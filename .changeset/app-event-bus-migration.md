---
'@faapi/faapi': minor
'@faapi/agent': minor
---

框架扩展点全量收敛为 app 事件总线 + 零入口唯一化（`$start` + `src/bootstrap.ts`）——维护者决策（2026-10 会话，逐项明确指示）：**对外扩展统一走事件订阅一种模型，存量钩子删除；编程式启动入口移除，零入口是唯一入口**。

> 版本策略留痕：本变更按语义属破坏性（公开导出与配置钩子删除、生成入口模板变更），经维护者指示以 minor 随 7.x 线发布——迁移说明逐项列明（见文末），发版后由维护者按 `faapi-dev` 技能文档同步业务侧。

## @faapi/faapi

**新增：app 级事件总线**（契约见 `src/events/appEventBus.md`）

- `getApp().on(name, handler)`：唯一订阅入口（封闭强类型目录 `FaapiAppEventMap`，目录外名字编译报错、载荷类型自动推导、无 `unknown` 逃逸口）；handler 原地改写载荷（改写式扩展点）；订阅返回退订函数（幂等）；随 `app.close()` 清空
- **`src/bootstrap.ts` 约定启动文件**：`export default async function bootstrap()`，内部 `getApp().on(...)`——`createProdApp`/`createDevApp` 在 app 创建后、listen 前加载执行（窗口由框架给出）；`app:boot`/`app:ready`/`app:close` 三个启动期事件的唯一订阅位置；变更需重启（与 `.env` 同款）；机制见 `src/cli/bootstrap.md`
- 事件目录（12 项，agent 域均含 `:<agentName>`/`:<toolName>` 专属变体，先通用后专属同一载荷对象串联）：
  - agent 域：`agent:root-input`（对话首条 user 消息改写，进历史）、`agent:input`（每轮 LLM 调用前改写发送副本）、`agent:before-tool-call`（执行守卫：改写 `args` / 设 `error` 拒绝）、`agent:after-tool-call`（成功审计，观察类）、`agent:filter-tools`（LLM 可见 tools 过滤）、`agent:system-prompt`（systemPrompt 装饰）、`agent:sub-agent-context`（派发上下文供数）
  - 应用/任务域：`app:boot`（listen 前，订阅端抛错端口不暴露）、`app:ready`（listen 后）、`app:close`（drain 后）、`request:error`（错误响应发出后，观察类）、`task:failed`（任务失败/取消后，观察类）
- 错误口径两类：流程/改写类传播（fail fast），观察类 `console.error` 留痕不干扰主流程

**新增：`$start`（唯一公开启动导出）**

- `$` 前缀 = 框架内部标记：**仅供生成的 `dist/main.js` 使用**，业务不应直接调用
- 完整启动：`createProdApp`（产物水合 + bootstrap 执行）→ `listen()`；`options.dist` 由 `faapi build --dist` 写入生成模板

**删除**

- `createApp` / `createProdApp` / `createDevApp` 公开导出与 `App`/`ProdApp`/`DevApp`/`CreateAppOptions` 类型——`createProdApp`/`createDevApp` 转为不公开导出的内部模块（CLI 编排专用）。**存量项目的 `dist/main.js`（import createProdApp）升级后启动即报错，需重跑 `faapi build` 重新生成**
- `FaapiConfig.lifecycle` 与 `LifecycleHooks`（onBoot/onReady/onClose/onError）——改订阅 `app:boot`/`app:ready`/`app:close`/`request:error`（写 `src/bootstrap.ts`）；`LifecycleContext` 类型保留为事件载荷
- `config.agent.beforeToolCall` / `afterToolCall` / `filterTools`——改订阅 `agent:before-tool-call`/`agent:after-tool-call`/`agent:filter-tools`
- `config.task.onFailed`——改订阅 `task:failed`（`TaskFailedInfo` 类型保留为载荷）
- `createServer`/`createTestServer` 的 `onError` 选项——`createServer` 改经 `registries.appEvents` 发射 `request:error`；`createTestServer` 新增 `appEvents?: AppEventBus` 选项（业务测试自行构造总线注入断言）
- `AppRegistries` 增加 `appEvents` store（app 实例级，`close()` 清理）；`AppBase.on` 公开订阅入口、`AppBase` 类型导出

**类型迁移（非破坏）**：`LLMMessage` / `LLMToolCall` / `LLMToolDefinition` 规范类型自 `@faapi/agent` 迁入主包（`src/events/llmMessageTypes.ts`，事件载荷引用）——`@faapi/agent` 侧 re-export 保持既有导入路径不变。

## @faapi/agent

**新增**：`AgentDeps.emitAppEvent`（可选，插件经 `createAgentDeps` 的 `overrides` 注入 `registries.appEvents.emit`）——agent 循环七接缝经此发射事件；未注入（未加载插件/编程式裸 Agent）事件不发射、行为原样。

**删除**

- `AgentDeps.resolveRootInput` / `resolveSubAgentInput`——输入改写由 `agent:root-input`（任意 depth 的对话首条 user 消息）承载
- `AgentDeps.resolveSystemPrompt` / `resolveSubAgentContext`——由 `agent:system-prompt` / `agent:sub-agent-context` 事件承载
- `AgentRuntimeConfig.beforeToolCall` / `afterToolCall` / `filterTools` 及 `ToolCallGuard` / `ToolCallGuardHook` / `AfterToolCallHook` / `FilterToolsHook` 类型——由 `agent:before-tool-call` / `agent:after-tool-call` / `agent:filter-tools` 事件承载

## 业务迁移路径

1. 启动逻辑（原 `faapi.config.ts` 的 `lifecycle: {...}`）：新建 `src/bootstrap.ts`，`export default async function bootstrap()` 内 `getApp().on('app:boot' | 'app:ready' | 'app:close' | 'request:error', ...)`
2. `config.agent` 三钩子 / deps 四钩子 → `app.on('agent:...', handler)`（守卫改写 `e.args` / 设 `e.error`；改写类事件载荷原地修改）
3. `config.task.onFailed` → `app.on('task:failed', handler)`
4. **升级后重跑 `faapi build`** 重新生成 `dist/main.js`（旧生成物 import 已删除的 `createProdApp`）
5. 详见 `packages/faapi/src/events/appEventBus.md` 与 `packages/faapi/src/cli/bootstrap.md`
