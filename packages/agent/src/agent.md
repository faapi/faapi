# agent

一句话概括：Agent 类——按 `agent.name` 查找元数据、组装 tool 列表（tools + sub-agent）、提供 `run` / `stream` / `asTool`,把 [reactLoop](./reactLoop.md) 与 faapi 核心的 agent/tool 注册表粘合起来,并在 sub-agent 递归时传递 `enableTracing`、把子循环结果包装为 [SubAgentToolResult](./reactLoop.md)（携带 `usage` / `turns` 供父循环上卷,tracing 开启时再附 sub-trace）。

## 为什么需要

[reactLoop](./reactLoop.md)（Phase 3.3）是纯循环引擎——它只接收 `ReactLoopConfig`（provider + systemPrompt + tools + executeTool + maxTurns），不关心 tool 从哪来、如何加载、sub-agent 如何递归。需要一个组件负责「组装 config」和「执行 tool」：

- **组装 tool 列表**——从 faapi 核心的 `agentRegistry.resolveAgentTools` + `resolveSubAgents` 合并出 `LLMToolDefinition[]`（OpenAI chat completions 规范形）,每个 tool 的 `function.parameters` 为 JSON Schema
- **执行 tool**——`reactLoop` 调 `executeTool(name, args, enableTracing)` 时,Agent 路由：
  - 常规 tool（声明集合精确命中）→ `loadToolModule` 加载 handler + 可选 input 校验 → 调用
  - sub-agent 派发名（`agent-<name>`,构建期建立的「派发名 → agent 名」映射命中）→ 递归构造 sub-agent 调用（含 `maxAgentDepth` 防护 + 传递 `enableTracing`）——**不按名字前缀猜测路由**,真工具与派发名互不误伤
- **递归防护**——`maxAgentDepth` 限制 agent 调用 agent 的深度,防止无限递归
- **tracing 接线**——`run` 返回后填充 `result.trace.agentName`（reactLoop 不知 agent 名）；sub-agent 调用时传递 `enableTracing` 并把 sub-trace 附在 [SubAgentToolResult](./reactLoop.md) 上,让 reactLoop 发出 `subagent_call` 事件
- **usage / turns 冒泡**——sub-agent 走默认 reactLoop 时,把子循环整树的 `usage` / `turns` 包装进 `SubAgentToolResult` 返回,reactLoop 累加进父 run 台账（详见 [reactLoop.md](./reactLoop.md)「usage 与 turns 的整树口径」）

Agent 类把这些「胶水」逻辑集中在一处,reactLoop 保持纯函数。

## 使用场景

- **Phase 3.5 集成**：faapi 核心 agent 注入器构造 `Agent` 实例（注入真实注册表/加载器访问器），包装为 `AgentHandle`（含可调用 `run` / `stream`）注入到 handler 的 `agent` 参数
- **sub-agent 递归**：reactLoop 执行 `agent-<name>` 派发 tool 时,Agent 构造子 Agent（depth+1）并调其 `run`
- **agent-as-tool**：通过 `asTool(name)` 把指定 agent 包装为 `AgentToolDescriptor`,加入 LLM 可见 tool 列表

## 设计

### 核心类型

| 类型 | 说明 |
| --- | --- |
| `AgentDeps` | Agent 运行时依赖（providers Map + llms + rootDir + config + 请求上下文透传 ctx + 注册表/加载器访问器 + 可选 schema 解析器 / `agent:system-prompt` 装饰事件发射器；无默认 provider / 默认 agent 名——每次调用显式指定） |
| `AgentRuntimeConfig` | 全局 agent 配置覆盖（maxTurns / maxAgentDepth / enableTracing） |
| `ToolSchemaResolution` | tool schema 解析结果（jsonSchema 给 LLM + validate 给执行前校验） |
| `AgentRecursionError` | sub-agent 递归超 `maxAgentDepth` 时抛出 |
| `SubAgentToolResult` | sub-agent tool 的结构化返回值（`{ __subAgent: true, result, usage?, turns?, trace? }`）——reactLoop 据此上卷子循环 `usage` / `turns`、剥壳回传、发 `subagent_call` 事件（`trace` 存在时）。详见 [reactLoop.md](./reactLoop.md)「usage 与 turns 的整树口径」与 [trace](./trace.md) |

### 依赖注入（DI）

Agent 类**不直接 import** faapi 核心的注册表/加载器,而是通过 `AgentDeps` 接收访问器函数。原因：

- **可测试**——测试传 mock 访问器,无需启动真实注册表（与 [reactLoop.test](./reactLoop.test.ts) 同构）
- **解耦**——Agent 类不依赖核心运行时模块,核心模块变化不影响 Agent 逻辑
- **phase 边界**——Phase 3.4 实现 Agent 类逻辑,Phase 3.5 注入真实访问器（核心导出注册表/加载器后接线）

`AgentDeps` 访问器签名与 faapi 核心对称：

| 访问器 | 对应核心模块 | 说明 |
| --- | --- | --- |
| `getAgent(name)` | [agentRegistry.getAgent](../../faapi/src/injection/agentRegistry.md) | 查 agent `AgentCore`（LLM 可见字段：`name` / `description` / `systemPrompt` / `tools` / `agents` / `model` / `maxTurns` / `inputDescription`）。仅查文件 registry |
| `getAgentEntry(name)` | [agentRegistry.getAgentEntry](../../faapi/src/injection/agentRegistry.md) | 查 agent `AgentMetadata`（继承 `AgentCore` + `filePath`）。仅查文件 registry |
| `getTool(name)` | [toolRegistry.getTool](../../faapi/src/injection/toolRegistry.md) | 查 tool 元数据（filePath / functionName / inputTypeName） |
| `resolveAgentTools(name)` | [agentRegistry.resolveAgentTools](../../faapi/src/injection/agentRegistry.md) | agent 显式声明的 tools 引用（仅查文件 registry） |
| `resolveSubAgents(name)` | [agentRegistry.resolveSubAgents](../../faapi/src/injection/agentRegistry.md) | agent 可调用 sub-agent 列表（`AgentCore[]`,仅查文件 registry） |
| `loadToolModule(...)` | [loadToolModule](../../faapi/src/loaders/loadToolModule.md) | 动态 import tool handler |
| `resolveToolSchema?(tool)` | Phase 3.5 实现 | tool input 的 JSON Schema + 校验函数（基于 `zod.js` + `z.toJSONSchema`） |
| `resolveAgentInputSchema?(agent)` | 同上（同一 resolver 实例） | sub-agent 派发入参 schema 解析（`AgentMetadata` 的 `inputTypeName` → zod.js → JSON Schema + 校验函数），见「派发入参 schema 声明」；未提供时派发一律走单字段 `input` 模式（编程式组装的向后兼容） |
| `emitAppEvent?(name, payload)` | —（`@faapi/agent` 插件经 `overrides` 注入） | app 事件发射器（[appEventBus](../../faapi/src/events/appEventBus.md)）：`agent:system-prompt` / `agent:sub-agent-context` / `agent:before-tool-call` / `agent:after-tool-call` / `agent:filter-tools` / `agent:root-input` / `agent:input` / `agent:history-over-budget` 八接缝经此发射。未注入（未加载插件 / 编程式裸 Agent）→ 事件不发射、行为原样（能力边界） |

### `AgentDeps.ctx`（执行上下文契约，必填）

`ctx: AgentToolContext`——tool handler 第二参数与鉴权类事件订阅端的统一契约（类型声明在主包 `@faapi/faapi` 的 [agentToolContext.md](../../faapi/src/runtime/agentToolContext.md)，本包 re-export）。**必有，基础字段（`tasks` / `log` / `signal`）由框架在三条约执行路径上合成保证正确**；本契约不支持 `declare module` 增强（type alias 拒绝合并）——业务身份字段（`currentUserId` 等）以**业务类型交叉标注**携带（`type CtxWithUser = AgentToolContext & { currentUserId?: number }`，路径依赖字段用可选表达），在场性由各路径填充规则决定、业务侧 fail-closed 断言消费。请求绑定字段（`request` / `headers` 等）与宿主函数值面（`config` / `registries`）**不进契约**——任务侧物理不存在，访问即编译错误。

| 路径 | ctx 来源 |
| --- | --- |
| HTTP 请求（@faapi/agent 插件工厂） | `toAgentToolContext` 从完整请求 ctx 收窄（契约字段 + 全量字段透传） |
| 任务（`taskCtx.agent` 静默通道） | `createTaskToolContext` 合成：carry 数据字段落顶层 + scoped TaskClient / 任务级 logger / `job.signal` |
| 测试 / 编程式（无 app 编排） | `createStandaloneToolContext`（诚实缺省：tasks 抛错桩 / console logger / 永不触发 signal） |

`AgentDeps.ctx` 为**必填**（类型层强制 + `createAgentDeps` 运行时 invariant）——无 ctx 的 Agent 组装会让 tool handler 第二参数缺席，契约破坏即显式失败。sub-agent 递归复用同一 deps，ctx 随行不变。完整传递链见 [toolChainEvents.md](./toolChainEvents.md)，任务侧组装示例见主包 [taskTypes.md](../../faapi/src/tasks/taskTypes.md)「任务内组装 Agent」。

### `Agent` 类方法

```ts
class Agent {
  constructor(deps: AgentDeps, depth?: number);  // depth 默认 1（根 agent）
  async run(input?: string, options?: AgentRunOptions): Promise<ReactLoopResult>;
  async *stream(input?: string, options?: AgentRunOptions): AsyncIterable<ReactLoopStreamChunk>;
  asTool(name: string): AgentToolDescriptor | undefined;
}
```

- `run(input?, options?)` —— 组装 `ReactLoopConfig`（应用 `options` 覆盖）→ 调 `reactLoop(input, config)` → 填充 `result.trace.agentName = options.agent`（reactLoop 不知 agent 名）。入口挂载执行作用域（[agentScope](./agentScope.md)）：整条循环 promise 链在当前 agent 作用域内，tool 内部经 `getAgentScope()` 只读
- `stream(input?, options?)` —— 组装 config（应用 `options` 覆盖）→ 调 `reactLoopStream(input, config)`（流式 chunk 含 `traceEvent`,不含顶层 `AgentTrace`,无需事后填 agentName）。同样挂载执行作用域——ALS 的 async generator 语义（体内上下文随消费方 `next()` 走）决定了实现是逐次在作用域内驱动内层迭代器，见 [agentScope.md](./agentScope.md)「实现要点」
- `asTool(name)` —— 把指定 agent 包装为 `AgentToolDescriptor`（`kind: 'agent'` / `name: 'agent-<name>'`,经 [subAgentToolName](../../faapi/src/injection/subAgentToolName.md) 生成 / `metadata`）;未注册返回 `undefined`

`input` 可选（续跑场景不传新输入）：`input` 与 `options.messages` 都为空时抛 `AgentError`；
`options.messages` 提供时以历史为基础 + system 自动补齐 + 非空 `input` 追加为 user 消息,
语义详见 [reactLoop.md](./reactLoop.md) 中断恢复章节。

`AgentRunOptions` 定义在 [agentHandle](./agentHandle.md),`model` 字段是字符串 key
（支持 llms key 精确匹配 / `provider/model` 一体化 / 纯 model 名三种形式）,允许本次调用
临时切换 provider + model + temperature + maxTokens + enableTracing,不修改 agent 自身状态——适用于
「按请求切模型 / provider」的运行时动态切换场景。详见 [agentHandle.md](./agentHandle.md)
的「`options.model` 字符串 key 解析规则」。

`options.enableTracing` 用于覆盖全局 tracing 配置（默认沿用 `config.agent.enableTracing`,
全局默认 `false`——opt-in）,详见 [trace](./trace.md) 的「触发机制」章节。

### config 组装流程

`run` / `stream` 内部先组装 `ReactLoopConfig`：

1. `options.agent` 取本次调用的 agent 名（不传抛 `AgentError`——无默认 agent）,`getAgent(agentName)` 取元数据,未注册抛 `AgentError`
2. `buildToolDefinitions()`（async,因 schema 解析）组装 `LLMToolDefinition[]`
3. config 字段优先级（高 → 低）：`options`（本次调用传入）> agent 元数据（`systemPrompt` / `model` / `maxTurns`）> 全局 `AgentRuntimeConfig`

| 字段 | options 覆盖 | agent 元数据 | 全局默认 |
| --- | --- | --- | --- |
| `agentName` | `options.agent`（必须显式传） | — | — |
| `provider` | `options.provider` 外部 provider（最高,跳过 llms 解析）/ `options.model` 解析出的 provider（key 含 provider 时） | — | —（无默认 provider,`meta.model` 作为缺省 key 解析） |
| `model` | `options.model`（外部 provider 时为原始 model 名原样透传）/ `options.model` 解析出的 model | `meta.model`（未传 `options.model` 时作为缺省 key） | — |
| `temperature` | `options.temperature` | — | `LlmConfig.temperature`（provider 级透传） |
| `maxTokens` | `options.maxTokens` | — | `LlmConfig.maxTokens`（provider 级透传） |
| `maxTurns` | — | `meta.maxTurns` | `AgentRuntimeConfig.maxTurns` |
| `maxHistoryTokens` | — | — | `AgentRuntimeConfig.maxHistoryTokens`（历史超限事件触发阈值,未设置 = 不估算不发射;框架零内置裁剪——超限承接见 [reactLoop.md](./reactLoop.md) 的 `agent:history-over-budget` 章节） |
| `toolTimeoutMs` | — | — | `AgentRuntimeConfig.toolTimeoutMs`（未设置 = 不限时;`faapi.config` 的 `agent.toolTimeoutMs` 经 `toAgentRuntimeConfig` 拆装到达） |
| `enableTracing` | `options.enableTracing` | — | `AgentRuntimeConfig.enableTracing`（默认 `false`） |

`options.model` 是字符串 key,解析规则见 [agentHandle.md](./agentHandle.md) 的「`options.model` 字符串 key 解析规则」。
`options.model` 未传且无 `options.provider` 时抛 `AgentError`——模型是调用侧决策,无 config fallback；
两者皆无且未传 `options.provider` 时抛 `AgentError`（无默认 provider）。

`options.provider` 传外部 provider（`LlmConfig` 配置对象或 `LLMProvider` 实例）时优先级最高——
完全跳过 llms key 解析,`options.model` 变为原始 model 名原样透传（支持带 `/` 的 model id）。
仅本次调用生效,sub-agent 递归继承父调用解析出的 provider。详见 [agentHandle.md](./agentHandle.md) 的
「`options.provider` 外部 provider」章节。

### systemPromptFile（提示词文件）

agent config 声明 `systemPromptFile: 'prompts/review.md'`（相对产物 resources 目录的字符串,
启动期随 config 导出求值进 AgentCore,与 `systemPrompt` 互斥——两者都声明或都缺失启动期抛错,二选一必填）时,`buildLoopConfig`
在**每次 run/stream 时读文件内容**作为 system 消息,不走缓存——dev 改 prompt 文件经 watcher
增量复制进 `.faapi/resources/` 后立即生效,无需 reload。

- 文件定位：主包免传参 `readResource(meta.systemPromptFile, 'utf-8')`——相对产物 resources
  目录（`<rootDir>/<dist>/resources`）解析，越界（绝对路径 / `..` 穿越 / 符号链接逃逸）
  防护内建。读取根在 app 启动时由 `createAppBase` 绑定
  （见主包 [readResource.md](../../faapi/src/utils/readResource.md)），调用方无需传目录
- 错误语义：读取失败（读取根未绑定 / 文件不存在 / 越界）→ 抛 `AgentError`
  （带 agent 名与文件路径），不静默降级为空提示词
- 路径基准为产物 resources 目录（读取经主包免传参 `readResource`，详见 [copyResources](../../faapi/src/cli/copyResources.md)）
- 内容含 `{{...}}` 占位符时配合 config 的 `vars` 声明做模板注入,见下节

### vars 提示词模板变量（config 静态声明）

agent config 支持 `vars: Record<string, string | number | boolean>`（启动期求值进
AgentCore.vars,声明与校验规则见主包
[loadAgents.md](../../faapi/src/agents/loadAgents.md)）——systemPrompt /
systemPromptFile 内容中的 `{{key}}` 占位符按 vars 渲染（渲染实现见
[promptTemplate.md](./promptTemplate.md)）：

```ts
// prompts/reviewer.txt 内声明 {{role}} / {{focus}},同一模板被多个 agent 复用
export const config = {
  systemPromptFile: 'prompts/reviewer.txt',
  vars: { role: '情节审稿', focus: '逻辑链完整性' },
};
```

- **适用场景**：同一提示词模板复用 + agent 间静态特化——vars 是构建期固化的字面量,
  同一 agent 每次运行渲染相同内容;每次运行不同的动态内容走 user input 或派发入参
  （per-agent `Input` schema）,不适用本机制
- **触发条件**：config 声明 vars（含空对象）→ 渲染;未声明 → 完全不渲染,逐字节现状
  （存量提示词中的 `{{...}}` 字面文本不受影响）
- **全链生效**：顶层 run / stream 与 sub-agent 派发一致——vars 在 agent 元数据上,
  派发的子代理同样按其自身 config.vars 渲染
- **缺失变量显式抛错**：占位符在 vars 中无对应值 → `AgentError`（带 agent 名与占位符名）,
  不发起 LLM 请求,不静默留占位符
- **渲染时机**：base 解析（systemPromptFile 读文件 / 内联 systemPrompt）之后、
  `agent:system-prompt` 事件之前——订阅端看到渲染后内容
- **新鲜度**：每次 run / stream / 派发渲染,不缓存——dev 改 prompt 文件立即生效

### `agent:system-prompt` systemPrompt 装饰事件（base + 应用装饰）

`Agent.resolveSystemPrompt` 在框架解析好 base（内联 `systemPrompt` 字面量 / `systemPromptFile` 文件内容 / `vars` 模板渲染——语义与现状完全一致）之后，经 `deps.emitAppEvent` 发射 [appEventBus](../../faapi/src/events/appEventBus.md) 的 `agent:system-prompt` 与 `agent:system-prompt:<agentName>`（先通用后专属，同一载荷对象）。**handler 改写 `payload.prompt` 即最终 system 消息**；未订阅 = 原样返回 base——逐字节现状。

为什么需要：组装层要在框架解析结果之上叠加应用层装饰（共享协议块 / 条件块 / DB 运行时层）——「base + 装饰」是通用形状（A/B 文案、租户注入、按用户个性化）。没有这个 seam，应用只能「包装 `getAgent` / `resolveSubAgents` 访问器 + 组装期预读 prompt 文件建快照 + 从包装视图剥除 `systemPromptFile` 声明」三件套机械。提示词是 LLM-facing 面的最后一个扩展点，统一由事件承载。

语义细则：

| 项 | 语义 |
| --- | --- |
| base 解析顺序 | `systemPromptFile` 优先直读，失败抛 `AgentError`（事件不发射）；内联缺省 `''`（reactLoop 按 truthy 处理，不插 system 消息）。agent config 声明 `vars` 时 base 先经 vars 渲染（见上方「vars 提示词模板变量」），事件载荷收到渲染后内容 |
| 载荷 | `{ prompt, ctx }`——不含 agent 名（按 agent 路由订阅专属名 `agent:system-prompt:<agentName>`，名字在事件名里）；handler 改写 `prompt`；多 handler 串联（专属看到通用改写） |
| 错误传播 | handler 抛错原样上抛，走 run / stream 既有错误链；不吞不降级（**传播**口径） |
| 调用时机 | 每次 run / stream、每次 sub-agent 派发各一次（`buildLoopConfig` 内，与现行文件直读同款新鲜度——dev 改 prompt 文件立即生效） |
| 子代理传导 | deps 全树共享（emitAppEvent 随 deps 传导）——一次订阅覆盖主控与全部可达子代理 |
| 与 `systemPromptFile` 关系 | 声明继续为真：框架照常解析 base，应用在其上叠加——注册表视图保持诚实，无需剥除声明 |

订阅示例：

```ts
import { getApp } from '@faapi/faapi';

// 启动期订阅写 src/bootstrap.ts（框架在 listen 前加载执行）;运行期可订阅于任意拿得到 app 的位置
getApp().on('agent:system-prompt:chapter-writer', async (e) => {
  // 专属订阅即按 agent 路由——agent 名在事件名里,载荷不含 agentName
  const protocol = await loadProtocolBlock('chapter-writer'); // 应用层装饰：共享协议块 / 条件块 / DB 运行时层
  e.prompt = `${e.prompt}\n\n${protocol}`;
});
```

### `agent:sub-agent-context` 派发上下文事件（按派发参数供数）

`executeSubAgent` 在派发入参校验通过后、子循环启动之前，发射 `agent:sub-agent-context` 与 `agent:sub-agent-context:<subName>`——**handler 设置 `payload.context` 即追加进子代理最终 system 消息**（`agent:system-prompt` 链路结果之后，`\n\n` 分隔；不设 / 空串跳过）。未订阅 = 现状逐字节。

为什么需要：「按本次派发参数异步取数并送达子代理」（如按 `novelId`/`chapterNo` 服务端查库把数据快照注入子代理 systemPrompt，子代理冷启动即见写作依据，省掉自己调工具读的数轮）——`agent:system-prompt` 事件只见 agent 身份不见派发参数，本事件补上派发边界的供数通道。两者职责正交（装饰决定整条消息，本事件只贡献末尾上下文块）。

语义细则：

| 项 | 语义 |
| --- | --- |
| 调用时机 | 仅 `executeSubAgent` 内、派发入参校验通过之后、子循环启动之前发射——`args` 已是 coerce 后的可信值；根调用不发射 |
| 载荷 | `{ args, context?, ctx }`——不含 subName（按子代理路由订阅专属名 `agent:sub-agent-context:<subName>`，名字在事件名里）；`args` 为校验后的派发入参；handler 设置 `context`（多 handler 后设覆盖） |
| 追加语义 | `context` **追加**不替换——子代理最终 system = `agent:system-prompt` 链路结果 + `\n\n` + context。业务不碰 base |
| 跳过规则 | 不设或空串不追加（不产生空块 / 前导分隔符）；子代理 base 为空串时最终 system 即 context 产出 |
| 实例隔离 | 每次派发构造独立子 Agent 实例——同轮 `Promise.all` 并行派发各自注入，无交叉污染 |
| 错误传播 | handler 抛错原样上抛，被 reactLoop per-tool catch 回传主控 LLM（主控可调整派发参数重试），不吞不降级（**传播**口径） |
| 树级传导 | deps 全树共享——一次订阅覆盖全部可达派发层级（含 sub-sub 孙代理） |
| 流式一致 | 流式 / 非流式父循环同一接线（发射先于两分支分流），子代理 system 消息一致 |

订阅示例：

```ts
import { getApp } from '@faapi/faapi';

getApp().on('agent:sub-agent-context:chapter-writer', async (e) => {
  const snapshot = await buildContextPacket(e.args.novelId, e.args.chapterNo, e.ctx?.currentUserId);
  e.context = snapshot; // 框架追加进子代理 system 消息，业务不碰 base
});
```

### `agent:root-input` 对话首条 user 消息事件（loop 首个用户输入的塑形出口）

root-input 是「loop 首个用户输入那一轮」的 input：事件单独保留（一次对话只发一次、按 agent 专属名路由、订阅端无需判首轮），落账实现与 `agent:input` 复用同一条管道，写面只有 `addInput`。

`buildLoopConfig` 在 `agentName` 解析与注册校验之后、循环启动之前，对**非空 `input`**（任意 depth）经 `deps.emitAppEvent` 发射 [appEventBus](../../faapi/src/events/appEventBus.md) 的 `agent:root-input` 与 `agent:root-input:<agentName>`（先通用后专属，同一载荷对象）：

- **触发语义**：「本次对话的首条 user 消息」——depth=1 是根调用输入；depth≥2 是子代理派发（`executeSubAgent` → `subAgent.run/stream(extractSubAgentUserInput(args))`，载荷 `input` 为派发入参 schema 校验、提取后的 user 输入字符串——即子代理 LLM 实际看到的首条 user 消息）；纯续跑（`options.messages` + 无 `input`）不触发。
- **载荷形制**：`{ input, ctx, addInput }`——不含 `agentName`。按 agent 路由订阅专属名 `agent:root-input:<agentName>`（agent 名在事件名里），通用订阅 `agent:root-input` 是 agent 无关的横切处理。`input` 只读（getter-only，赋值抛 `TypeError`），写面只有 `addInput(text, index = 100)`。
- **落账实现（与 `agent:input` 同管道）**：root-input 片段在循环启动前暂存（`ReactLoopConfig.appEvent.rootInputStaging`），loop 首轮 `agent:input` 发射后与该轮片段**合并为一条**首条 user 消息——同 index 下 root-input 片段在前（暂存更早）；排序、空白过滤、`'\n\n'` 拼接、`{{rawInput}}` 占位符展开（原输入嵌在片段指定位置、不再缀尾）全部复用 reactLoop 的落账逻辑，见 [reactLoop](./reactLoop.md)「agent:input 用户输入发送前事件」。
- **能力边界**：原输入恒在首条 user 消息中——可包裹、重排（`{{rawInput}}`），**不可丢弃或改写原文**（输入非空由 `buildLoopConfig` 入口守卫承担）。
- **产物去向**：落账进循环历史并随 `result.messages`（非流式）/ `done.messages`（流式）导出——业务落库、续跑链继承、前端按标记渲染全链可见；trace 的 `inputSnapshot` 如实反映落账后的 LLM 输入。
- **错误传播**：handler 抛错在循环启动前上抛——depth=1 走 run / stream 既有错误链（发起 LLM 请求前显式失败）；depth≥2 被 reactLoop per-tool catch 回传主控 LLM（主控可调整派发参数重试）。
- **未接线**：`emitAppEvent` 缺席（未加载插件 / 编程式裸 Agent）→ 事件不发射、输入原样（能力边界，非降级）。

塑形示例（`src/bootstrap.ts` 或模块顶层订阅，业务方无需编程式接线）：

```ts
import { getApp } from '@faapi/faapi';

getApp().on('agent:root-input:chapter-writer', async (e) => {
  // 请求级现查库供数,块在前 + 真实输入收尾;包裹/顺序/收尾形态全是业务决策
  const blocks = await buildContextBlocks(e.input, e.ctx.currentUserId);
  e.addInput([...blocks, '<user_input>\n{{rawInput}}\n</user_input>'].join('\n\n'));
});

// 产物作为首条 user 消息进历史,随 result.messages 导出 → 业务落库 →
// 续跑轮经 options.messages 传回,块随历史继承
```

用户输入消息发送前的补充输入（`agent:input`，与 root-input 同口径仅输入轮发射——loop 首轮非空 input；工具轮 / 纯续跑轮不发射、不虚构新增 user 消息；片段落账进历史、append-only 不可变）见 [reactLoop](./reactLoop.md) 的「agent:input 用户输入发送前事件（历史编辑窗口）」。

### sub-agent 派发工具命名（subAgentToolName）

sub-agent 包装为 tool 发给 LLM 时,`function.name` 受 OpenAI 兼容协议硬约束 `^[a-zA-Z0-9_-]+$`（DeepSeek / OpenAI 等强校验上游对非法字符整单 400）。命名规则由主包 [subAgentToolName](../../faapi/src/injection/subAgentToolName.md) 统一：

- **派发名 = `agent-<agentName>`**——前缀 `agent-`（点号等非法字符违反协议）
- agent 名本身须合法：文件型 agent 由 [scanAgents](../../faapi/src/agents/scanAgents.md) 目录段字符集校验保证（段内 `[a-zA-Z0-9-]`,`_` 为嵌套分隔符,如 `easy-writing_wizard`）
- **执行路由不按前缀猜测**——`buildLoopConfig` 时建立「派发名 → agent 名」映射（`agentToolNames`）与常规 tool 声明集合（`declaredTools`）两个结构,`executeTool` 按声明来源路由：真工具 `agent-foo`（即使注册表存在、甚至声明了）与 sub-agent `foo` 的派发名 `agent-foo` 不会互相误伤
- **构建期冲突显式抛 `AgentError`**：某 sub-agent 的派发名与该 agent 声明的常规 tool 名相同（如声明了 tool `agent-writer` 又声明 sub-agent `writer`）→ 抛错要求改名——静默遮蔽会让其中一方不可达

`agent:before-tool-call` / `agent:after-tool-call` 事件收到的 sub-agent 派发名即派发工具名（`agent-<name>`）,业务方用主包导出的 `SUB_AGENT_TOOL_PREFIX` 判别前缀,不硬编码字符串。

### `buildToolDefinitions()` —— tool 列表组装

合并两个来源（按 `name` 去重,先入者保留）：

1. **agent.tools 引用** —— `resolveAgentTools(agentName)` 返回 agent 显式声明的 `tools` 引用
2. **sub-agent** —— `resolveSubAgents(agentName)` 每个经 [subAgentToolName](../../faapi/src/injection/subAgentToolName.md) 包装为 `agent-<name>`,入参 schema 按「派发入参 schema 声明」二选一：

**富 schema 模式**（sub-agent 的 handler.ts 顶层声明 `interface Input` / `type Input`,经 `getAgentEntry(name)` 取到 `inputTypeName`）——`parameters` 来自该 agent 的 zod.js（`resolveAgentInputSchema` 解析,字段 JSDoc 即主控 LLM 可见参数描述）：

```json
{
  "type": "object",
  "properties": {
    "novelId": { "type": "string", "description": "<字段 JSDoc>" },
    "chapterId": { "type": "number", "description": "<字段 JSDoc>" }
  },
  "required": ["novelId", "chapterId"]
}
```

**单字段 `input` 模式**（未声明 `Input`,或 `resolveAgentInputSchema` 未接线——完全向后兼容）：

```json
{
  "type": "object",
  "properties": {
    "input": {
      "type": "string",
      "description": "<sub 元数据 inputDescription,未声明时用框架默认文案>"
    }
  },
  "required": ["input"]
}
```

显式 `input` 字段是 agent-as-tool 的派发交接单——严格遵循 JSON schema 的模型（GLM 系列、OpenAI strict mode 等）对无属性 `{ type: 'object' }` 只会回空 `{}`,派发上下文传不进子代理（宽松填参的模型不受影响,问题隐性）。默认文案提示 LLM 传自然语言交接单;sub 元数据声明 `inputDescription`（agent config 块,启动期求值,见 [loadAgents](../../faapi/src/agents/loadAgents.md)）时覆盖默认文案,让 sub-agent 自述需要什么交接单。

### 派发入参 schema 声明（per-agent 富 schema）

默认单字段 `input` 交接单的语义只能写进 description 文字——结构性交接单（`novelId` / `chapterId` 等硬定位字段）无法做成 schema 硬表达,主控漏带字段只能等 sub-agent 内部工具报错回灌重试。子代理的 handler.ts 顶层声明 `Input` 后,派发工具与普通 tool 同口径：

- **声明即校验**——`buildToolDefinitions` 用 `resolveAgentInputSchema` 解析出的 JSON Schema 作为 `parameters`;`executeSubAgent` 执行前 `validate(args)`,失败返回 `{ error }` 回灌主控 LLM 重试（与常规 tool 校验失败同语义,不抛错、不进入子循环——省掉一次注定失败的子 agent 轮次）
- **传导**——校验通过后 `extractSubAgentUserInput` 把多字段 args `JSON.stringify` 为交接单文本传给子循环（单字段 `{ input: string }` 声明时仍直传字符串,子代理读原文）
- **产物**——zod.js 由构建期生成（`inputTypeName` 记入 faapi-agents.js 清单）,见主包 [generateAgentArtifacts](../../faapi/src/cli/generateAgentArtifacts.md);`inputDescription` 在富 schema 模式下不再参与该工具构建（字段描述来自字段 JSDoc,二者互斥以 `Input` 为准）
- **产物异常显式失败**——`resolveAgentInputSchema` 已接线但解析结果为 `undefined`（声明了 `inputTypeName` 而 zod.js 缺失/损坏,dev/prod 全量生成下只可能是产物异常）抛 `AgentError`,不静默退回单字段模式

每个常规 tool 的 `input`：
- `getToolSchema(tool)`（带缓存）提供 → 用其 `jsonSchema`
- 未提供 / tool 无 `inputTypeName` → 自由 schema `{ type: 'object' }`

### schema 缓存

`getToolSchema(tool)` 按 `tool.name` 缓存 `resolveToolSchema` 的解析结果（含 `undefined`）：
`buildToolDefinitions` 首次解析后写入缓存,`executeTool` 执行前校验时直接命中——
避免每次 tool 执行都重新 `loadToolSchema` + `z.toJSONSchema`。

实例级缓存：sub-agent 各有独立 cache（tool 集合可能不同）；`deps.resolveToolSchema` 未提供时不写缓存。

### `executeTool(name, args, enableTracing)` —— tool 执行路由

```ts
// 按声明来源路由(不按名字前缀猜测)——agentToolNames: 派发名 → sub agent 名
if (agentToolNames.has(name)) {
  return executeSubAgent(agentToolNames.get(name)!, args, enableTracing);  // sub-agent 递归(含 tracing)
}
const tool = getTool(name);
if (!tool) throw new Error(`Tool "${name}" not found`);
// 可选 input 校验(复用 buildToolDefinitions 的 schema 缓存)
const schemaRes = await getToolSchema(tool);
let callArgs = args;
if (schemaRes) {
  const v = schemaRes.validate(args);
  if (!v.ok) return { error: v.error };  // 校验失败,错误回传 LLM 让其重试
  callArgs = v.value ?? args;
}
const mod = await loadToolModule(tool.filePath, tool.functionName);
return await mod.handler(callArgs);
```

- **执行白名单（安全边界）**：`name` 必须落在当前 agent 的声明集合内——常规 tool 集合（`resolveAgentTools` 的 tool 名）或 sub-agent 派发名集合（`resolveSubAgents` 经 [subAgentToolName](../../faapi/src/injection/subAgentToolName.md) 生成的 `agent-<name>`,映射到真实 agent 名）,两者皆未命中一律拒绝,返回 `{ error: 'Tool "x" is not declared by agent "y"' }` 回传 LLM。`tools`/`agents` 声明不只是 LLM 可见性过滤——LLM 幻觉或被提示注入时可能请求未声明的任意已注册 tool（如管理类 tool）,执行前按声明集合强制校验。sub-agent 递归时每个 depth 层按自己的声明集合校验
- **常规 tool 校验失败**：不抛错,返回 `{ error }` 对象——reactLoop 把它 stringify 后作为 tool 结果回传 LLM,LLM 可据此修正参数重试（与 [reactLoop](./reactLoop.md) 的「tool 错误回传 LLM」语义一致）
- **tool 未找到 / 加载失败**：抛错,被 reactLoop catch 后同样回传 LLM
- **`enableTracing` 参数**：由 [buildLoopConfig](#config-组装流程) 闭包捕获传入,用于 sub-agent 调用时决定是否包装 [TracingToolResult](./trace.md) 携带 sub-trace。常规 tool 不需要 tracing 包装,直接返回结果

### `executeSubAgent(subName, args, resolved)` —— sub-agent 递归

```ts
const newDepth = this.depth + 1;
const maxDepth = deps.config?.maxAgentDepth ?? DEFAULT_MAX_AGENT_DEPTH;
if (newDepth > maxDepth) throw new AgentRecursionError(maxDepth, newDepth);

const subAgent = new Agent(deps, newDepth);  // deps 共享（providers/llms/访问器）

// 派发入参校验（富 schema 模式,与常规 tool 同语义）:声明了 inputTypeName 时
// resolveAgentInputSchema 解析 zod.js,失败返回 { error } 回灌 LLM,不进入子循环
const entry = deps.getAgentEntry(subName);
let callArgs = args;
if (entry?.inputTypeName && deps.resolveAgentInputSchema) {
  const schemaRes = await deps.resolveAgentInputSchema(entry);
  if (!schemaRes) throw new AgentError(...);        // 产物异常显式失败,不静默降级
  const v = schemaRes.validate(args);
  if (!v.ok) return { error: v.error };             // 回灌主控 LLM 重试
  callArgs = v.value ?? args;
}

// 派发上下文事件:校验通过后发射 agent:sub-agent-context,handler 设置的
// context 注入本实例（buildLoopConfig 追加进子代理 system 消息）;不设/空串跳过,
// 抛错原样上抛（per-tool catch 回传 LLM）
subAgent.subAgentContextBlock = await emitSubAgentContextEvent(subName, callArgs);

// 默认 reactLoop:继承父调用的 provider,sub 的 model 用其元数据声明（未声明沿用父 model）
const subMeta = deps.getAgent(subName);
const result = await subAgent.run(
  extractSubAgentInput(callArgs),  // 单字段 { input: string } 直传字符串;其余形状 stringify 兜底
  {
    agent: subName,
    enableTracing: resolved.enableTracing,
    provider: resolved.provider,                        // 继承父 provider
    model: subMeta?.model ?? resolved.model,            // sub 自身声明优先,否则沿用父 model
  },
);

// 包装 SubAgentToolResult:usage/turns 供父循环上卷,trace 存在时发 subagent_call 事件
return {
  __subAgent: true,
  result: result.content,
  usage: result.usage,   // 子循环整树用量(逐层上卷)
  turns: result.turns,   // 子循环整树轮数
  ...(enableTracing && result.trace ? { trace: result.trace } : {}),
};
```

- **`maxAgentDepth`**：默认 3。depth 从 1（根）开始,sub-agent 为 2、3...,超出抛 `AgentRecursionError`
- **派发入参校验（富 schema 模式）**：sub 元数据声明 `inputTypeName`（handler.ts 顶层 `Input` 导出,见「派发入参 schema 声明」）且 `deps.resolveAgentInputSchema` 已接线时,执行前 `validate(args)`——失败返回 `{ error }` 回灌主控 LLM 重试（与常规 tool 校验失败同语义,不进入子循环）;通过后以 coerce 后的 value 继续传导。解析结果 `undefined`（声明了但 zod.js 缺失/损坏）抛 `AgentError` 显式失败。resolver 未接线（编程式组装/测试）或未声明 `Input` 时跳过校验
- **派发上下文事件**：`emitAppEvent` 已接线时,校验通过后发射 `agent:sub-agent-context` / `agent:sub-agent-context:<subName>`（载荷 `args`/`ctx`,不含 subName——按子代理路由订阅专属名,名字在事件名里;handler 设置 `context`）——产出注入本子 Agent 实例,子循环 `buildLoopConfig` 在 `agent:system-prompt` 改写结果之后以 `\n\n` 追加为最终 system 消息（见「`agent:sub-agent-context` 派发上下文事件」）。未接线 / 未设 `context` / 空串时逐字节现状
- **首条 user 消息事件**：派发入参校验通过后，子循环 `buildLoopConfig` 对非空 `input` 发射 `agent:root-input` / `agent:root-input:<subName>` 事件（载荷 `input` 为提取后的 user 输入字符串，只读），handler 经 `addInput`（配 `{{rawInput}}` 占位符）包裹——片段在子循环首轮与 `agent:input` 片段同管道落账，产物即子代理首条 user 消息并进子对话历史（见「`agent:root-input` 对话首条 user 消息事件」）。`emitAppEvent` 未接线时输入原样
- **`getAgentEntry` vs `getAgent`**：`getAgentEntry` 返回 `AgentMetadata`（含 `filePath` + `inputTypeName`）,`getAgent` 返回 `AgentCore`。两者都仅查文件 registry。sub-agent 必须是文件型 agent
- **默认 reactLoop + provider 继承**：sub-agent 统一走默认循环,调 `subAgent.run(input, { agent, provider, model, enableTracing })`——继承父调用解析出的 provider 与 model（外部 provider 或 llms 解析结果;sub 不声明模型,恒沿用父调用解析结果）。user 消息的提取规则：args 恰为单字段 `{ input: <string> }`（与默认入参 schema 形状一致）时直传 `input` 字符串;其余形状（宽松模型多传字段 / 传空对象 / 老客户端任意 JSON）`JSON.stringify(args)` 兜底,不丢信息、向后兼容。`enableTracing=true` 时 subAgent.run 返回的 `result.trace`（agentName 已被 `Agent.run` 填为 subName）附在 `SubAgentToolResult` 的 `trace` 字段返回给 reactLoop,reactLoop 识别后发出 `subagent_call` 事件,嵌入 sub-trace（递归结构,业务方可还原完整调用树）。`usage` / `turns` 字段始终携带（子循环整树口径,reactLoop 上卷进父 run 台账,详见 [reactLoop.md](./reactLoop.md)「usage 与 turns 的整树口径」）。`usage` / `turns` 缺省（如 provider 不返回用量）时 reactLoop 跳过对应累加

### Tracing

Agent 类是 [trace](./trace.md) 的「接线层」——reactLoop 只关心循环逻辑,不知道：

- **agent 名**：`reactLoop` 返回的 `result.trace.agentName` 是空字符串。`Agent.run` 在 reactLoop 返回后填充 `result.trace.agentName = options.agent`（sub-agent 调本方法时也走此路径,subAgent.run 返回的 trace.agentName 自动是 subName）
- **常规 tool vs sub-agent**：reactLoop 只调 `executeTool(name, args)`,不区分。Agent 在 `executeSubAgent` 中把默认 reactLoop 的子循环结果统一包装为 `SubAgentToolResult`——`usage` / `turns` 供 reactLoop 上卷进父 run 台账；`trace` 存在时（`enableTracing=true`）reactLoop 发 `subagent_call` 事件并嵌入 sub-trace,否则发 `tool_call` 事件。tracing 关闭时包装仍发生（用量上卷不依赖 tracing,是台账的正道）,仅多两个字段,开销可忽略

#### 业务方使用示例

**调试单个 agent 调用**（拿 `result.trace` 本地日志 / 开发面板展示）：

```ts
import type { AgentHandle } from '@faapi/agent';

// src/api/chat/handler.ts
export async function POST(agent: AgentHandle, body: { input: string }) {
  const result = await agent.run(body.input, { enableTracing: true });
  console.log('agent trace:', JSON.stringify(result.trace, null, 2));
  return { content: result.content, turns: result.turns };
}
```

**生产路径关闭 tracing**（高 QPS 端点零开销）：

```ts
import type { AgentHandle } from '@faapi/agent';

// src/api/chat/handler.ts
export async function POST(agent: AgentHandle, body: { input: string }) {
  const result = await agent.run(body.input, { enableTracing: false });
  return { content: result.content };
}
```

或全局关闭（`faapi.config.ts`）：

```ts
import type { FaapiConfig } from '@faapi/faapi';
export default {
  agent: { enableTracing: false, /* llms 等 *\/ },
} satisfies FaapiConfig;
```

**流式前端展示**（通过 SSE 推送 traceEvent）：

```ts
import type { AgentHandle } from '@faapi/agent';

// src/api/chat/handler.ts
export async function POST(agent: AgentHandle, ctx, body: { input: string }) {
  const sse = ctx.sse();
  for await (const chunk of agent.stream(body.input, { enableTracing: true })) {
    if (chunk.deltaContent) sse.send({ event: 'delta', data: chunk.deltaContent });
    if (chunk.toolCall) sse.send({ event: 'tool_call', data: chunk.toolCall });
    if (chunk.toolResult) sse.send({ event: 'tool_result', data: chunk.toolResult });
    if (chunk.subagentEvent) sse.send({ event: 'subagent_event', data: chunk.subagentEvent });
    if (chunk.traceEvent) sse.send({ event: 'trace', data: chunk.traceEvent });
    if (chunk.done) sse.send({ event: 'done', data: chunk.done });
  }
  sse.close();
}
```

**sub-agent 嵌套调试**：父 agent 调 sub-agent 时,sub-agent 的 trace 自动嵌入父 trace 的 `subagent_call` 事件（`enableTracing=true` 时,详见 [trace.md](./trace.md) 的「sub-agent 嵌套 trace」章节）,业务方可还原完整调用树。sub-agent 的中间事件（LLM 增量、tool 调用/结果）经 `chunk.subagentEvent` 实时直播到父流（见 [reactLoop.md](./reactLoop.md)「子代理事件冒泡」）,与 trace 的回放视图互补。

### 错误处理

| 错误 | 类型 | 处理 |
| --- | --- | --- |
| agent 未注册 | `AgentError` | `run`/`stream` 抛错（调用方负责捕获） |
| sub-agent 递归超限 | `AgentRecursionError` | 抛错,被父 reactLoop catch 后回传 LLM |
| 派发名与声明 tool 名冲突 | `AgentError` | `run`/`stream` 构建期抛错——改名 tool 或 sub-agent（见「sub-agent 派发工具命名」） |
| agent 名非法（派发名违反工具名字符集） | `Error` | [subAgentToolName](../../faapi/src/injection/subAgentToolName.md) 抛错（程序化 hydrate 的 agent 名不经构建期扫描,此处是最后闸门） |
| tool 未找到 / 加载失败 | `Error` | 抛错,被 reactLoop catch 后回传 LLM |
| tool input 校验失败 | 返回 `{ error }` | 不抛错,作为 tool 结果回传 LLM 重试 |
| LLM provider 抛错 | 透传 | reactLoop 不 catch,立即传播 |

### `asTool(name)` —— agent 包装为 tool

```ts
asTool(name: string): AgentToolDescriptor | undefined {
  const meta = deps.getAgent(name);
  if (!meta) return undefined;
  return {
    kind: 'agent',
    name: subAgentToolName(meta.name),  // 'agent-<name>',见 subAgentToolName.md
    agentName: meta.name,
    description: meta.description,
    metadata: meta,
  };
}
```

与 [agentRegistry.asTool](../../faapi/src/injection/agentRegistry.md) 同构——Agent 类自带此方法便于在注入器场景直接调用（不必再过注册表）。

## 相关模块

- [reactLoop](./reactLoop.md) —— Phase 3.3,Agent 的 `run`/`stream` 委托给它
- [promptTemplate](./promptTemplate.md) —— 提示词模板渲染（config 的 `vars` 静态声明）,`agent:system-prompt` 事件发射前 base 解析后调用
- [agentScope](./agentScope.md) —— 执行作用域（`getAgentScope`）,挂载点在 `Agent.run`/`stream` 入口,sub 换栈经 executeSubAgent 委托链统一发生
- [trace](./trace.md) —— Tracing 类型与文档（`AgentTrace` / `AgentTraceEvent` / `TracingToolResult`）,Agent 类是其「接线层」（填 agentName + 包装 sub-agent 返回值）
- [reactLoop.md](./reactLoop.md)「usage 与 turns 的整树口径」—— `SubAgentToolResult` 的上卷语义与边界
- [provider](./provider.md) —— Phase 3.2,Agent 构造时持有 `providers` Map（由 plugin 从 `config.agent.llms` 遍历调 `createProvider` 创建）
- faapi 核心 [agentRegistry](../../faapi/src/injection/agentRegistry.md) —— `AgentDeps` 访问器的真实实现来源（Phase 3.5 接线）
- faapi 核心 [toolRegistry](../../faapi/src/injection/toolRegistry.md) —— tool 元数据查询
- faapi 核心 [loadToolModule](../../faapi/src/loaders/loadToolModule.md) —— 动态加载 tool handler
- faapi 核心 [agentTypes](../../faapi/src/agents/agentTypes.md) / [extractToolMetadata](../../faapi/src/ast/extractToolMetadata.md) —— agent/tool 元数据类型定义
