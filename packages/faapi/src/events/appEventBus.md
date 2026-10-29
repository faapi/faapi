# appEventBus（app 级事件总线）

一句话概括：app 实例级的事件总线——**框架全部流程扩展点的统一出口**，业务方经 `getApp().on(name, handler)` 监听（启动期事件写 `src/bootstrap.ts` 约定文件，由框架在正确时机加载），handler 可原地改写事件载荷（改写式扩展点，非只读观察）。

## 为什么需要

框架在关键流程点（对话输入组装、每轮 LLM 调用、tool 调用边界、应用启动/关闭、请求错误、任务失败……）需要业务可监听、可改写的扩展点。这类接缝若各自为政——每个点一套声明面、传递链与错误约定——业务方要逐个学习，框架也要逐点维护。事件总线把全部流程扩展收敛为**一种模型**：一个目录、一种订阅模型（订阅/退订/专属名/载荷改写）、两类错误口径。改写消息语义上是同步转换，事件 handler 原地改写载荷承接；事件目录封闭强类型（目录外编译报错，无 `unknown` 逃逸口）。

## 事件目录（封闭，随框架版本演进）

### agent 域（改写类，含 `:<agentName>`/`:<toolName>` 专属变体）

> **载荷统一口径**：agent 域载荷不含实体名（agent 名 / tool 名）——专属名订阅承载实体路由（名字在事件名里），通用订阅是实体无关的横切处理，避免「载荷字段分流」与「专属名订阅」两条等价路径并存的使用困惑。

| 事件名 | 载荷 | 触发时机 |
| --- | --- | --- |
| `agent:root-input` | `AgentRootInputEvent`（`{ input, ctx, addInput }`） | 所有 agent 对话首次 user 消息发送前——根调用（depth=1）与子代理派发（depth≥2）；纯续跑不触发。`input` 为首条 user 输入原文（只读），写面是 `addInput`——与 `agent:input` 同一条落账管道（片段在 loop 首轮与 `agent:input` 片段合并落账进首条 user 消息，`{{rawInput}}` 占位符展开为原输入） |
| `agent:input` | `AgentInputEvent`（`{ depth, messages, ctx, addInput }`） | 当轮有新 user 输入时、该 user 消息发送前（loop 首轮非空 input——根调用与子代理派发同口径），历史超限事件之前；工具轮 / 纯续跑轮（当轮无新 user 输入）不发射、不虚构新增 user 消息；`messages` 为历史只读快照，`addInput` 片段落账进当轮输入消息 |
| `agent:history-over-budget` | `AgentHistoryOverBudgetEvent`（`{ depth, estimatedTokens, budget, messages, ctx, replace }`） | 每轮估算历史 tokens 超过 `maxHistoryTokens` 阈值时（`agent:input` 落账之后）；业务经 `replace` 整体替换循环历史——框架零内置裁剪，压缩完全由订阅端承接 |
| `agent:before-tool-call` | `BeforeToolCallEvent` | tool/sub-agent 执行前——ctx 声明即校验之后、白名单与分流之前；handler 原地改写 `args`、设 `error` 拒绝 |
| `agent:after-tool-call` | `AfterToolCallEvent` | tool/sub-agent 成功执行后（异常路径不触发）；name 为 tool 名（sub-agent 为派发名 `agent-<name>`） |
| `agent:filter-tools` | `FilterToolsEvent` | 每次 run/stream 组装 LLM 可见 tool 清单末尾；handler 原地增删 `tools` 数组 |
| `agent:system-prompt` | `SystemPromptEvent` | 框架解析好 base systemPrompt（内联/`systemPromptFile`/vars 渲染）之后；handler 改写 `prompt` 即最终 system |
| `agent:sub-agent-context` | `SubAgentContextEvent` | 子代理派发入参校验通过后；handler 设 `context` 为追加进子代理 system 的上下文块（多 handler 后设覆盖） |

```ts
// agent 域载荷统一不含路由键（agent 名 / tool 名）——专属名订阅承载实体路由
// （名字在事件名里）,通用订阅是实体无关的横切处理（见下方「通用名与专属名的分工」）
export interface BeforeToolCallEvent {
  args: Record<string, unknown>; // handler 可整体替换（payload.args = {...}）
  ctx: AgentToolContext;
  error?: string;             // handler 设置即拒绝执行（扇出后统一判定,回传 LLM）
}
export interface AfterToolCallEvent {
  args: Record<string, unknown>;
  result: unknown;            // 成功结果（观察/审计面,改写不回写）
  ctx: AgentToolContext;
}
export interface FilterToolsEvent {
  tools: LLMToolDefinition[]; // handler 原地 filter/splice
  ctx: AgentToolContext;
}
export interface SystemPromptEvent {
  prompt: string;             // vars 渲染后的 base——handler 改写即最终 system 消息
  ctx: AgentToolContext;
}
export interface SubAgentContextEvent {
  args: Record<string, unknown>; // 校验后的派发入参
  context?: string;           // handler 设置 → 追加进子代理 system（\n\n 拼接,空串/不设跳过）
  ctx: AgentToolContext;
}
```

### 应用与任务域（全局事件，无专属变体）

| 事件名 | 载荷 | 触发时机 |
| --- | --- | --- |
| `app:boot` | `LifecycleContext` | listen 内、server.listen 前——启动校验/迁移等「失败即不该暴露端口」的逻辑 |
| `app:ready` | `LifecycleContext` | listen 回调内——资源初始化 |
| `app:close` | `LifecycleContext`（server 有值） | close 内、任务 drain 之后——清理 |
| `request:error` | `RequestErrorEvent` | 服务端故障（5xx）错误响应**发出后**——日志/告警副作用；已处理 4xx（404/405/422/业务 4xx）不发射，观察走请求日志（4xx → warn）；`ctx` 不存在（请求准备阶段错误）不发射 |
| `task:failed` | `TaskFailedInfo`（复用任务类型：task/jobId/attempt/willRetry/cancelled/error） | 任务每次执行失败/取消后（含 willRetry 失败与 cancelled） |

```ts
export interface RequestErrorEvent {
  error: unknown;
  ctx: FaapiContext;          // 仅服务端故障（5xx）发射（已处理 4xx 不发射）；请求准备阶段错误无 ctx → 整个事件不发射
}
```

`LifecycleContext`（rootDir/routes/server/registries/tasks/config 活引用）是 `app:*` 事件的载荷类型。

## 订阅（唯一入口 `getApp().on`，启动期写 src/bootstrap.ts）

```ts
// src/bootstrap.ts —— 框架约定的启动文件（机制见 [cli/bootstrap](../cli/bootstrap.md)）：
// createProdApp/createDevApp 在 app 创建后、listen 前加载执行——getApp() 可用、事件未发射，
// app:boot/app:ready/app:close 三个启动期事件的唯一订阅位置
import { getApp } from '@faapi/faapi';

export default async function bootstrap() {
  const app = getApp();

  app.on('app:boot', ({ server }) => {
    if (!process.env.DB_HOST) throw new Error('DB_HOST is required'); // 抛错 → 端口不暴露
  });
  app.on('app:ready', async ({ registries }) => {
    await initDb();
  });
  app.on('app:close', async () => {
    await closeDb();
  });

  // agent 域 / 观察类事件也可在这里统一订阅，或写在各自模块顶层（app 运行中随时可订）
  app.on('agent:root-input', (e) => {
    e.addInput(`[tenant:${currentTenant()}] {{rawInput}}`);     // 占位符处嵌原输入，产物落账进对话历史
  });
}
```

- handler 同步或返回 `Promise`；`emit` 按注册顺序 `await` 依次执行。
- **改写语义**：handler 原地修改载荷（或对标记可赋值的字段整体赋值，如 `payload.args` / `payload.context`）；多 handler 顺序串联（后者看到前者改写结果）。
- **通用名与专属名的顺序**：每个接缝先发射通用名、后发射专属名（`agent:input:<agentName>` 等），**同一载荷对象**顺序串联——专属 handler 看得到通用 handler 的改写并可覆盖。
- **输入事件的写面（`agent:root-input` 与 `agent:input` 同一条落账管道）**：两事件的唯一写面都是 `addInput(text, index = 100)`——片段按 index 升序稳定排序（同 index 保持调用序）后 `'\n\n'` 拼接，前置进**当轮输入消息**（原内容逐字节不动），**落账进对话历史、落账即不可变**；拼接结果含 `{{rawInput}}` 占位符时占位符展开为原输入（原输入嵌在订阅端指定位置、不再缀尾）。两事件均**仅输入轮发射**（当轮有新 user 输入——root-input 为对话首条、`agent:input` 为 loop 首轮；工具轮 / 纯续跑轮当轮无新 user 输入，不发射、不虚构新增 user 消息）。`agent:root-input` 在 loop 首轮之前暂存，与首轮 `agent:input` 的片段**合并为一条**首条 user 消息（同 index 下 root-input 片段在前）；`input` 只读（getter-only，赋值抛 `TypeError`），原输入恒在消息中——可包裹/重排、不可丢弃或改写原文（显式声明的能力边界）。`agent:input` 的 `messages` 为历史只读快照（深冻结克隆，整体替换赋值抛 `TypeError`）。完整契约见 `@faapi/agent` [reactLoop](../../../agent/src/reactLoop.md) 同名章节。
- **通用名与专属名的分工（agent 域统一口径）**：专属名（`agent:root-input:<agentName>`、`agent:before-tool-call:<toolName>` 等）是按实体（agent/tool）路由的入口——名字在事件名里；**通用名载荷不含实体名**（agent 名 / tool 名一概不在载荷上）——通用订阅做实体无关的横切处理（租户改写、审计打标、全量守卫等），需要按实体分流时订阅对应专属名。
- 订阅返回退订函数（幂等）；无订阅者 emit 为 no-op；订阅集合随 `app.close()` 清空。

## 错误口径（两类，按接缝性质锚定）

| 口径 | 事件 | 行为 |
| --- | --- | --- |
| **流程/改写类——传播** | `app:boot`（失败端口不暴露）、`app:ready`、`app:close`、`agent:root-input`、`agent:input`、`agent:history-over-budget`、`agent:before-tool-call`（per-tool catch 回灌主控 LLM）、`agent:filter-tools`、`agent:system-prompt`、`agent:sub-agent-context`（同回灌） | handler 抛错立即向 `emit` 调用方传播（剩余 handler 跳过）——fail fast，不吞不降级 |
| **观察类——留痕** | `request:error`（不干扰已发出的响应）、`task:failed`（不影响驱动重试决策）、`agent:after-tool-call`（不改变成功结果） | 发射点捕获 handler 抛错，`console.error` 留痕后继续 |

**改写后校验（框架强制，仅改写类 agent 事件）**：`agent:history-over-budget` 的 `replace` 产物须非空且结构完整，违反抛 `AgentError`。`agent:root-input` / `agent:input` 的写面是 `addInput` 文本片段（空白片段过滤、无结构约束；原输入恒在消息中），无需扇出后校验——输入非空由 `agent.run/stream` 入口守卫（无 input 且无续跑历史抛 `AgentError`）承担。

## 发射侧（框架内部接线）

- 总线实例挂 `AppRegistries.appEvents`（app 实例级，`app.close()` 时 `clear()`）；`@faapi/agent` 插件 setup 时把 `registries.appEvents.emit` 经 `createAgentDeps` 的 `overrides.emitAppEvent` 注入 `AgentDeps`——HTTP 请求路径与隔离任务 RPC 路径（宿主执行）同一份 deps。
- `createProdApp`/`createDevApp` 内部加载执行 `src/bootstrap.ts`（listen 前窗口）；`listen()` 发射 `app:boot`/`app:ready`、`close()` 发射 `app:close`（副作用流程：boot 失败仍停任务运行时、close 仍在 drain 后）。
- `createServer` 的 `sendErrorResponse` 发射 `request:error`（仅服务端故障 5xx，响应发出后；SSE 流中断路径不按状态码门控）；`taskQueue` 发射 `task:failed`（fire-and-forget）。

## 能力边界（显式声明，非降级）

- 未加载 `@faapi/agent` 插件、或编程式裸 `new Agent(deps)`（deps 无 `emitAppEvent`）→ agent 域事件不发射、输入原样（能力不存在非降级）。`app:*`/`request:error`/`task:failed` 由主包发射，不依赖插件。
- 业务自定义事件名不支持——目录封闭是「`on` 无 unknown」的前提；新框架事件随版本进 `FaapiAppEventMap`。
- 启动期事件（`app:boot`/`app:ready`/`app:close`）的订阅必须写 `src/bootstrap.ts`（框架在 listen 前加载执行，见 [cli/bootstrap](../cli/bootstrap.md)）——handler 模块按需编译在首次请求才加载，届时 app:boot/app:ready 已发射。
- 订阅时机在发射之后不影响已开始的发射；发射开始时的订阅快照生效（扇出中途退订不影响在途分发）。

## 相关模块

- [llmMessageTypes](./llmMessageTypes.md)——`LLMMessage`/`LLMToolCall` 规范类型
- [registries](../injection/registries.md)——`AppRegistries.appEvents` 存储
- [createAppCore](../cli/createAppCore.md)——`AppBase.on`、`app:boot/ready/close` 发射点、close 清理
- [configTypes](../configs/configTypes.md)——`LifecycleContext`（`app:*` 载荷）
- [taskTypes](../tasks/taskTypes.md)——`TaskFailedInfo`（`task:failed` 载荷）
- `@faapi/agent` [agent](../../../agent/src/agent.md)——agent 域接缝
- `@faapi/agent` [reactLoop](../../../agent/src/reactLoop.md)——`agent:input` 接缝
- `@faapi/agent` [plugin](../../../agent/src/plugin.md)——`emitAppEvent` 注入
