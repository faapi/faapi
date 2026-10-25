# registries

一句话概括：app 级注册表集合——tool / agent / agentHandle / taskHandle / llm / agentRunner 的实例化实现，每个 app 持有独立一套，随 app 创建与销毁。

## 为什么需要

注册表此前是模块级全局单例 + hydrate 整体替换语义，生命周期与 app 实例脱钩：

- 同进程两个 app（测试 / 嵌入 / 多租户），后创建的 app 水合时**覆盖**先创建的 app 的清单——先创建的 app 请求拿到的是别人的 tool/agent，且无任何报错
- 任一 app close 会清空全部注册表（已先前的所有权守卫缓解，但覆盖端无解）

实例化后注册表挂在 app 上：多 app 天然隔离，`app.close()` 清自己的实例，互不影响。

## 使用场景

- `createAppBase`：创建 `AppRegistries` → 水合 faapi-tools.js / faapi-agents.js 到实例 → 经 `FaapiContext.registries` / `PluginContext.registries` / `LifecycleContext.registries` 传递
- `@faapi/agent` 插件经 `ctx.registries.agentHandle.register(...)` 注册工厂，deps 读同套实例
- `@faapi/agent` 插件经 `ctx.registries.llm.register(...)` 注册轻量补全通道（`LlmChannelStore`，存实例本身而非工厂——channel 与请求上下文无关），handler 的 `llm` 注入参数与任务执行上下文（进程内 `taskCtx.llm`）读取
- `@faapi/agent` 插件经 `ctx.registries.agentRunner.register({ runAgent })` 注册 agent 循环执行器，隔离任务队列读同套实例

## AgentRunner（agent 循环执行器）

隔离任务调 agent 的通道：worker 侧 `taskCtx.agent.run` 经**单次 `agent-run` RPC** 转发请求，宿主经本执行器跑**完整编排循环**（LLM IO + tool 调度 + beforeToolCall/afterToolCall 钩子 + reminders 渲染 + sub-agent 递归）——worker 只负责转发与回传，业务函数面与资源零跨线程。此前「IO 在 worker、CPU 在宿主」的 6 种 per-behavior RPC 垫片整体下线。

```ts
export interface AgentRunRequest {
  /** 目标 agent 名（原 AgentHandle.run options.agent——调用侧决策） */
  agentName: string;
  /**
   * 用户输入（可选——续跑场景不传新输入）。字符串为 user 消息直传；结构化对象
   * 为富 schema 派发形态（宿主先按 agent 的 Input schema 校验，再经
   * extractSubAgentUserInput 构造 user 消息——与 sub-agent 派发同约定）
   */
  input?: string | Record<string, unknown>;
  /** 本次调用的 LLM 配置（AgentRunOptions 纯数据形态；原样透传宿主） */
  options?: Record<string, unknown>;
}

export interface AgentRunner {
  /** 执行一次完整 agent 循环，返回 ReactLoopResult 纯数据；失败上抛（RPC ok:false 回传） */
  runAgent(ctx: AgentToolContext, request: AgentRunRequest, execution?: { signal?: AbortSignal }): Promise<unknown>;
}

export interface AgentRunnerStore {
  /** 注册执行器（null 清理）；二次注册覆盖 */
  register(runner: AgentRunner | null): void;
  /** 执行器已注册时返回实例，未注册返回 undefined */
  get(): AgentRunner | undefined;
  clear(): void;
}
```

要点：

- **纯数据边界**：request / 返回值均须可结构化克隆（跨 postMessage，不可克隆按执行错误显式失败）；`options.provider` 仅支持 `LlmConfig` 纯数据形态，`LLMProvider` 实例不可跨线程（worker 侧代理显式报错指引）
- **ctx 由调用方注入**：执行器不感知任务——`taskQueue` 以任务合成契约 ctx（carry + scoped TaskClient + 任务级 logger + job.signal，与进程内 `taskCtx.agent` 同配方，见 [taskToolContext.md](../tasks/taskToolContext.md)）调用 `runAgent(ctx, request)`；`execution.signal`（可选）为宿主侧任务取消控制器——执行器须传入 Agent 循环（ReactLoopConfig.signal），任务取消传播宿主中断 LLM IO（见 taskWorker.md「取消传播宿主」）
- **主包不反向依赖 agent 包类型**：`AgentRunRequest.options` 按结构声明为 `Record<string, unknown>`
- 注册时机：`@faapi/agent` 插件 `setup` 内注册（晚于队列构造）——队列**每次派发时** `deps.agentRunner?.get()` 取值，构造期快照不会漏注册
- 未注册时队列不注入 `onAgentRun`：run 消息不带 `agentChannel`，worker 内 `taskCtx.agent` 恒 undefined（能力不存在非降级）

RPC 协议与 worker 侧 run-only 句柄（`buildAgentRunProxy`）详见 [taskWorker.md](../tasks/taskWorker.md)。

## 默认实例与全局函数

`defaultRegistries` 是模块级默认实例；toolRegistry / agentRegistry / agentHandle 模块的同名全局函数（`getTool` / `listAgents` / `registerAgentHandleFactory` 等）保留为**默认实例的便捷访问器**，供编程式直调 / 单元测试 / 无 app 上下文场景。

注意：默认实例与 app 实例相互独立——经全局函数水合的数据不会出现在任何 app 的请求链路中；多 app 场景下默认实例无隔离语义（等同旧全局行为）。框架自身链路不读写默认实例。

## 任务侧只读视图（TaskRegistriesView）

`createTaskRegistriesView(registries)` 把 AppRegistries 投影为**只读视图**（agent 的 get/getEntry/list/asTool/resolve* + tool 的 get/list），注入任务执行上下文（`TaskContext.registries`）——任务执行侧（进程内或隔离 worker）不在 handler 请求链路上，拿不到 `FaapiContext.registries`；`getApp()` 在隔离线程内也不可用（worker globalThis 独立）。视图刻意不暴露 `hydrate`/`clear` 写接口：任务不是注册表的所有者。隔离路径经 `TaskRegistriesSnapshot` 纯数据快照跨线程、worker 内重建视图（agent 条目经 `toAgentSnapshotRecord` 投影，详见 `../tasks/taskTypes.md`）。

轻量补全通道不走该视图：`TaskContext.llm` 由任务队列从 `AppRegistries.llm` 单独接线（进程内惰性读 store；隔离路径为纯转发代理——worker 内 complete 经 llm-complete RPC 回宿主、由宿主从本注册表取派发时刻注册的通道执行，worker 不加载 `@faapi/agent`）。agent 循环执行器同理不走该视图：`TaskQueueDeps.agentRunner` 单独接线（每次派发时惰性取值）。

## 相关模块

- `toolRegistry.ts` / `agentRegistry.ts` / `agentHandle.ts` - 默认实例便捷访问器（委托层）
- `llmTypes.ts` - 轻量补全通道规范类型（`LlmComplete` / `LlmCompleteOptions`，实现在 `@faapi/agent`）
- `../tasks/taskWorker.md` - agent-run RPC 协议与 worker 侧 run-only 句柄
- `../tasks/taskQueue.md` - `onAgentRun` 注入与执行器消费时机
- `../cli/createAppCore.md` - 创建与水合时机
- `agentRegistry.md` - agent 注册表全局访问器
