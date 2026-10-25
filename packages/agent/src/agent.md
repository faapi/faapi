# agent

一句话概括：Agent 类——按 `agent.name` 查找元数据、组装 tool 列表（tools + sub-agent）、提供 `run` / `stream` / `asTool`,把 [reactLoop](./reactLoop.md) 与 faapi 核心的 agent/tool 注册表粘合起来,并在 sub-agent 递归时传递 `enableTracing`、链式续拼 [traceId](./traceId.md)、把子循环结果包装为 [SubAgentToolResult](./reactLoop.md)（携带 `usage` / `turns` 供父循环上卷,tracing 开启时再附 sub-trace）。

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
| `AgentDeps` | Agent 运行时依赖（providers Map + llms + rootDir + config + 请求上下文透传 ctx + 注册表/加载器访问器 + 可选 schema 解析器 / systemPrompt 装饰钩子；无默认 provider / 默认 agent 名——每次调用显式指定） |
| `AgentRuntimeConfig` | 全局 agent 配置覆盖（maxTurns / maxAgentDepth / enableTracing / traceId / traceIdTemplate） |
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
| `resolveSystemPrompt?(name, meta, base)` | —（应用组装层注入） | systemPrompt 装饰钩子：包装框架解析好的 base（内联字面量 / `systemPromptFile` 文件内容），返回值即最终 system 消息。见「resolveSystemPrompt 装饰钩子」 |
| `resolveSubAgentContext?(subName, args, ctx)` | —（应用组装层注入） | 派发上下文钩子：`executeSubAgent` 派发边界按派发参数异步供数，返回值由框架追加进子代理 system 消息。见「resolveSubAgentContext 派发上下文钩子」 |
| `resolveSubAgentInput?(subName, args, ctx)` | —（应用组装层注入） | 派发入参改写钩子：`executeSubAgent` 在派发入参校验之后异步改写派发 args，返回对象整体替换、改写结果进子代理首条 user 消息（交接单附件通道）。见「resolveSubAgentInput 派发入参改写钩子」 |
| `resolveRootInput?(agentName, input, ctx)` | —（应用组装层注入） | 根调用输入组装钩子：`run`/`stream` 入口对非空 `input` 异步组装，返回串整体替换本次 user 输入，产物进循环历史并随 `result.messages` / `done.messages` 导出。见「resolveRootInput 根调用输入组装钩子」 |

### `AgentDeps.ctx`（执行上下文契约，必填）

`ctx: AgentToolContext`——tool handler 第二参数与鉴权钩子的统一契约（类型声明在主包 `@faapi/faapi` 的 [agentToolContext.md](../../faapi/src/runtime/agentToolContext.md)，本包 re-export）。**必有，基础字段（`tasks` / `log` / `signal`）由框架在三条约执行路径上合成保证正确**；本契约不支持 `declare module` 增强（type alias 拒绝合并）——业务身份字段（`currentUserId` 等）以**业务类型交叉标注**携带（`type CtxWithUser = AgentToolContext & { currentUserId?: number }`，路径依赖字段用可选表达），在场性由各路径填充规则决定、业务侧 fail-closed 断言消费。请求绑定字段（`request` / `headers` 等）与宿主函数值面（`config` / `registries`）**不进契约**——任务侧物理不存在，访问即编译错误。

| 路径 | ctx 来源 |
| --- | --- |
| HTTP 请求（@faapi/agent 插件工厂） | `toAgentToolContext` 从完整请求 ctx 收窄（契约字段 + 全量字段透传） |
| 进程内任务（`taskCtx.agent` 静默通道） | `createTaskToolContext` 合成：carry 数据字段落顶层 + scoped TaskClient / 任务级 logger / `job.signal` |
| 隔离任务（worker 内 `taskCtx.agent`） | run-only 句柄（单次 agent-run RPC 收敛宿主）；宿主 runAgent 以任务合成契约 ctx 构造 Agent 跑完整循环（同配方合成，见 [taskToolContext.md](../../faapi/src/tasks/taskToolContext.md)） |
| 测试 / 编程式（无 app 编排） | `createStandaloneToolContext`（诚实缺省：tasks 抛错桩 / console logger / 永不触发 signal） |

`AgentDeps.ctx` 为**必填**（类型层强制 + `createAgentDeps` 运行时 invariant）——无 ctx 的 Agent 组装会让 tool handler 第二参数缺席，契约破坏即显式失败。sub-agent 递归复用同一 deps，ctx 随行不变。完整传递链见 [authHooks.md](./authHooks.md)，任务侧组装示例见主包 [taskTypes.md](../../faapi/src/tasks/taskTypes.md)「任务内组装 Agent」。

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
| `maxHistoryTokens` | — | — | `AgentRuntimeConfig.maxHistoryTokens`（未设置 = 不裁剪） |
| `toolTimeoutMs` | — | — | `AgentRuntimeConfig.toolTimeoutMs`（未设置 = 不限时;`faapi.config` 的 `agent.toolTimeoutMs` 经 `toAgentRuntimeConfig` 拆装到达） |
| `historyCompactor` | — | — | `AgentRuntimeConfig.historyCompactor`（缺省 = 现行截断；子代理共享根 deps 全树生效，见 [historyCompaction.md](./historyCompaction.md);不进 faapi.config 声明面——经 `agent.decorateDeps` 配方或 `overrides.config` 装配,见 [agentDeps.md](./agentDeps.md)） |
| `enableTracing` | `options.enableTracing` | — | `AgentRuntimeConfig.enableTracing`（默认 `false`） |
| `traceId` | `options.traceId`（显式指定,全局关闭也生效） | — | 自动生成（`AgentRuntimeConfig.traceId` 默认 `true`;显式 `false` 整体关闭）——生成/注入/链式规则详见 [traceId.md](./traceId.md) |

`options.model` 是字符串 key,解析规则见 [agentHandle.md](./agentHandle.md) 的「`options.model` 字符串 key 解析规则」。
`options.model` 未传且无 `options.provider` 时抛 `AgentError`——模型是调用侧决策,无 config fallback；
两者皆无且未传 `options.provider` 时抛 `AgentError`（无默认 provider）。

`options.provider` 传外部 provider（`LlmConfig` 配置对象或 `LLMProvider` 实例）时优先级最高——
完全跳过 llms key 解析,`options.model` 变为原始 model 名原样透传（支持带 `/` 的 model id）。
仅本次调用生效,sub-agent 递归继承父调用解析出的 provider。详见 [agentHandle.md](./agentHandle.md) 的
「`options.provider` 外部 provider」章节。

### traceId 组装与注入

`traceId`（默认开启,详见 [traceId.md](./traceId.md)）在 `buildLoopConfig` 内与 systemPrompt
同批组装：

1. **解析**：`options.traceId`（显式,最高——全局关闭也生效）> 全局开启时自动生成
   （`AgentRuntimeConfig.traceId !== false`,12 位十六进制段）> 关闭且未显式传 = `undefined`
2. **注入**：追加在最终 system 消息**末尾**,顺序为 `resolveSystemPrompt` 装饰结果 →
   `subAgentContextBlock` → traceId 块（框架级元数据,不经装饰钩子,业务 prompt 原样保留）
3. **两个不注入场景**：最终 system 为空（不凭空多出只含元数据的 system 消息）;续跑历史自带
   system 消息（本次 systemPrompt 本就不被采用,历史不被改写、不重复注入）
4. **传递**：本次 traceId 进 `callCtx`,`executeSubAgent` 为子调用链式续拼
   （父完整 ID + '.' + 新段,`subOptions.traceId`）——父关闭时子同样无,关闭语义整树一致
5. **暴露**：非流式 `result.traceId` + `result.trace.traceId`;流式 `done.traceId`;
   流式 sub 包装 `wrapped.trace.traceId`（非流式 sub 由子 `run()` 自行填充）

### systemPromptFile（提示词文件）

agent config 声明 `systemPromptFile: 'prompts/review.md'`（相对产物 resources 目录的字符串,
启动期随 config 导出求值进 AgentCore,与 `systemPrompt` 互斥——两者都声明或都缺失启动期抛错,二选一必填）时,`buildLoopConfig`
在**每次 run/stream 时读文件内容**作为 system 消息,不走缓存——dev 改 prompt 文件经 watcher
增量复制进 `.faapi/resources/` 后立即生效,无需 reload。

- 文件定位：主包免传参 `readResource(meta.systemPromptFile, 'utf-8')`——相对产物 resources
  目录（`<rootDir>/<dist>/resources`）解析，越界（绝对路径 / `..` 穿越 / 符号链接逃逸）
  防护内建。读取根在 app 启动时由 `createAppBase` 绑定、隔离任务 worker 由 wrapper 从
  快照播种（见主包 [readResource.md](../../faapi/src/utils/readResource.md)），调用方无需传目录
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
  `resolveSystemPrompt` 装饰钩子之前——钩子看到渲染后内容;traceId 块仍在其后追加
- **新鲜度**：每次 run / stream / 派发渲染,不缓存——dev 改 prompt 文件立即生效

### resolveSystemPrompt 装饰钩子（base + 应用装饰）

`AgentDeps.resolveSystemPrompt?: (agentName, meta, base) => Promise<string>`——systemPrompt 的解析 seam：框架解析好 base（语义与现状完全一致）后调用钩子，**返回值即最终 system 消息**。未声明钩子 = 原样返回 base——逐字节现状。

为什么需要：组装层要在框架解析结果之上叠加应用层装饰（共享协议块 / 条件块 / DB 运行时层）——「base + 装饰」是通用形状（A/B 文案、租户注入、按用户个性化）。没有这个 seam，应用只能「包装 `getAgent` / `resolveSubAgents` 访问器 + 组装期预读 prompt 文件建快照 + 从包装视图剥除 `systemPromptFile` 声明」三件套机械：同步闭包约束（访问器是同步签名，读文件只能前移到组装期）、防双拼靠纪律（须同时包装两个访问器才盖住主控 + 子代理树，漏一处即静默漏拼）、注册表视图不诚实（拼装后必须剥掉 `systemPromptFile` 声明，否则框架直读文件绕过全部拼装）。工具面已有 `resolveToolSchema` / `resolveAgentInputSchema` / authHooks 一整排接缝，提示词是最后一个没有的 LLM-facing 面。

语义细则：

| 项 | 语义 |
| --- | --- |
| base 解析顺序 | `systemPromptFile` 优先直读，失败抛 `AgentError`（钩子不被调用）；内联缺省 `''`（reactLoop 按 truthy 处理，与缺省 undefined 行为一致——不插 system 消息）。agent config 声明 `vars` 时 base 先经 vars 渲染（见上方「vars 提示词模板变量」），钩子收到渲染后内容 |
| 错误传播 | 钩子抛错原样上抛，走 run / stream 既有错误链；不吞不降级 |
| 调用时机 | 每次 run / stream、每次 sub-agent 派发各一次（`buildLoopConfig` 内，与现行文件直读同款新鲜度——dev 改 prompt 文件立即生效） |
| 子代理传导 | `executeSubAgent` 以同一 deps 构造子 Agent——一次注入覆盖主控与全部可达子代理，无需应用双包装 |
| 向后兼容 | 未声明钩子 = 逐字节现状；编程式组装在 deps 上直接注入 |
| 与 `systemPromptFile` 关系 | 声明继续为真：框架照常解析 base，应用在其上叠加——注册表视图保持诚实，无需剥除声明 |

`meta` 为该 agent 的 `AgentCore`（只读参考，钩子内改写不回写注册表）。框架工厂路径（`@faapi/agent` 插件）暂不透传此钩子——需要装饰的场景走编程式组装，deps 装配用官方工厂 `createAgentDeps`（[agentDeps.md](./agentDeps.md)，插件 setup / 任务内组装 / 自组装单一实现），差异项经 `overrides` 叠加：

```ts
import { Agent, createAgentDeps } from '@faapi/agent';

const agent = new Agent(
  createAgentDeps({
    registries: ctx.registries,
    // 7.0 起配置唯一入口是 agentConfig 复合块（无 faapi.config 的编程式场景可缺省）
    agentConfig: undefined,
    overrides: {
      resolveSystemPrompt: async (name, _meta, base) => {
        const protocol = await loadProtocolBlock(name); // 应用层装饰：共享协议块 / 条件块 / DB 运行时层
        return `${base}\n\n${protocol}`;
      },
    },
  }),
);
```

### resolveSubAgentContext 派发上下文钩子（按派发参数供数）

`AgentDeps.resolveSubAgentContext?: (subName, args, ctx) => Promise<string | undefined>`——sub-agent 派发边界的供数 seam：`executeSubAgent` 在派发入参校验通过后调用钩子，**返回值由框架追加进子代理最终 system 消息**（`resolveSystemPrompt` 链路结果之后，`\n\n` 分隔；`undefined` / 空串跳过）。未声明钩子 = 现状逐字节。

为什么需要：既有钩子「参数与异步能力错位」——`resolveSystemPrompt` 异步但只见 agent 身份不见派发参数（签名 `(agentName, meta, base)`），`beforeToolCall` 收得到派发 args 但是同步守卫。「按本次派发参数异步取数并送达子代理」（如按 `novelId`/`chapterNo` 服务端查库把数据快照注入子代理 systemPrompt，子代理冷启动即见写作依据，省掉自己调工具读的数轮）无缝可走。业务侧原本只能自建「同步暂存-异步消费」桥接（同步钩子推帧 + 装饰钩子消费），帧配对歧义靠纪律兜底——本钩子把该模式框架化。

语义细则：

| 项 | 语义 |
| --- | --- |
| 调用时机 | 仅 `executeSubAgent` 内、派发入参校验通过之后、子循环启动之前调用——`args` 已是 coerce 后的可信值；根调用（`run`/`stream` 顶层）不触发 |
| 参数 | `subName` 是**真实 agent 名**（非 `agent-<name>` 派发名——与 `beforeToolCall` / `afterToolCall` 收派发名不同，业务按 agent 名路由供数逻辑）；`args` 为校验后的派发入参；`ctx` 为 `deps.ctx` 请求上下文透传（与鉴权钩子同款） |
| 追加语义 | 返回值**追加**不替换——子代理最终 system 消息 = `resolveSystemPrompt` 链路结果 + `\n\n` + 钩子产出。业务不碰 base，与 `resolveSystemPrompt` 装饰职责正交（装饰决定整条消息，本钩子只贡献末尾上下文块） |
| 跳过规则 | 返回 `undefined` 或空串不追加（不产生空块 / 前导分隔符）；子代理 base 为空串时最终 system 即钩子产出 |
| 实例隔离 | 每次派发构造独立子 Agent 实例、产出注入该实例——同轮 `Promise.all` 并行派发各自注入，无交叉污染 |
| 错误传播 | 抛错原样上抛，被 reactLoop per-tool catch 回传主控 LLM（与 `AgentRecursionError` 同路径——主控可调整派发参数重试），不吞不降级 |
| 树级传导 | deps 全树共享——主控一次注入覆盖全部可达派发层级（含 sub-sub 孙代理） |
| 流式一致 | 流式 / 非流式父循环同一接线（钩子调用先于两分支分流），子代理 system 消息一致 |

使用示例（编程式组装 / 自组装 `overrides`）：

```ts
import { Agent, createAgentDeps } from '@faapi/agent';

const agent = new Agent(
  createAgentDeps({
    registries: ctx.registries,
    // 7.0 起配置唯一入口是 agentConfig 复合块（无 faapi.config 的编程式场景可缺省）
    agentConfig: undefined,
    overrides: {
      resolveSubAgentContext: async (subName, args, ctx) => {
        if (subName !== 'chapter-writer') return undefined; // 按真实 agent 名路由
        const snapshot = await buildContextPacket(args.novelId, args.chapterNo, ctx?.currentUserId);
        return snapshot; // 框架追加进子代理 system 消息，业务不碰 base
      },
    },
  }),
);
```

### resolveSubAgentInput 派发入参改写钩子（服务端合成材料进 user 消息）

`AgentDeps.resolveSubAgentInput?: (subName, args, ctx) => Promise<Record<string, unknown> | undefined>`——sub-agent 派发边界的入参改写 seam：`executeSubAgent` 在派发入参校验（富 schema 模式 zod `validate`）**之后**、user 消息构造（`extractSubAgentUserInput`）**之前**调用钩子，**返回对象整体替换派发 args**——改写后的 args 成为本次派发的最终入参，用于构造子代理首条 user 消息（交接单附件通道），并传导给后续全部消费点（`resolveSubAgentContext` 供数、`afterToolCall` 审计）。`undefined` 原样放行。未声明钩子 = 现状逐字节。

为什么需要：多 agent 协作里主控派发子代理只传轻量交接单（定位参数），子代理开工依据（设定 / 大纲 / 参考包 / 技能节）需要服务端在派发边界按 agent 材料清单**预取后拼进派发的 user 消息**（交接单附件）——材料是本轮任务数据，混进身份 / 纪律所在的 system 会模糊「每轮不变的纪律 vs 每轮变的数据」边界。既有钩子无处安放：`resolveSubAgentContext` 只能追加进 system（无 user 通道出口），`beforeToolCall` 是同步守卫（无法做查库预取）。本钩子补上这条缝，与 `resolveSubAgentContext` 职责正交（前者改 user 侧任务数据、后者供 system 侧上下文块）。

语义细则：

| 项 | 语义 |
| --- | --- |
| 调用时机 | 仅 `executeSubAgent` 内、派发入参校验通过之后、`resolveSubAgentContext` 之前调用——入参 `args` 已是 coerce 后的可信值；根调用（`run`/`stream` 顶层）不触发；校验失败（`{ error }` 回灌）时钩子不被调用 |
| 参数 | `subName` 是**真实 agent 名**（非 `agent-<name>` 派发名——与 `resolveSubAgentContext` 同款）；`args` 为校验后的派发入参；`ctx` 为 `deps.ctx` 请求上下文透传（与鉴权钩子同款） |
| 替换语义 | 返回普通对象 → **整体替换** args（不与原 args 合并——业务需要保留的字段自行展开 `...args`）；改写结果**不受 Input schema 约束**（校验已过、不再二次校验）——服务端合成材料字段无需声明进 `Input`，主控可见的派发 schema 保持干净 |
| 放行规则 | 返回 `undefined` → 原样放行（args 不变） |
| 形状守卫 | 返回非 `undefined` 且非普通对象（`null` / 数组 / 原始值）→ 抛 `AgentError`（含钩子名与 subName 的可行动错误信息，fail fast——业务代码 bug 不静默忽略） |
| user 消息 | 改写后的 args 经 `extractSubAgentUserInput` 构造子代理首条 user 消息——恰为单字段 `{ input: string }` 时直传字符串，其余形状 `JSON.stringify`（既有规则不变） |
| 全链一致 | 改写发生在 `resolveSubAgentContext` 之前——context 钩子与 `afterToolCall` 审计看到的都是改写后的最终 args |
| 错误传播 | 抛错原样上抛，被 reactLoop per-tool catch 回传主控 LLM（与 `resolveSubAgentContext` 同路径——主控可调整派发参数重试），不吞不降级 |
| 树级传导 | deps 全树共享——主控一次注入覆盖全部可达派发层级（含 sub-sub 孙代理） |
| 流式一致 | 流式 / 非流式父循环同一接线（钩子调用先于两分支分流），子代理首条 user 消息一致 |

使用示例（编程式组装 / 自组装 `overrides`）：

```ts
import { Agent, createAgentDeps } from '@faapi/agent';

const agent = new Agent(
  createAgentDeps({
    registries: ctx.registries,
    // 7.0 起配置唯一入口是 agentConfig 复合块（无 faapi.config 的编程式场景可缺省）
    agentConfig: undefined,
    overrides: {
      resolveSubAgentInput: async (subName, args, ctx) => {
        if (subName !== 'chapter-writer') return undefined; // 按真实 agent 名路由
        // 按材料清单服务端预取,拼进派发 user 消息(交接单附件);保留主控交接单原字段
        const material = await loadContextMaterial(args.novelId, args.chapterNo, ctx?.currentUserId);
        return { ...args, contextMaterial: material };
      },
    },
  }),
);
```

### resolveRootInput 根调用输入组装钩子（请求级动态上下文进 user 消息）

`AgentDeps.resolveRootInput?: (agentName, input, ctx) => Promise<string | undefined>`——根调用（对话轮）边界的输入组装 seam：`run`/`stream` 在 `buildLoopConfig` 内（`agentName` 解析与注册校验之后）对**非空 `input`** 调用钩子，**返回字符串整体替换本次 user 输入**——组装产物作为本次 run 的 user 消息进循环历史，随 `result.messages`（非流式）/ `done.messages`（流式）导出。`undefined` 原样放行。未声明钩子 = 现状逐字节。

为什么需要：长对话 agent 的每轮对话需要把请求级动态上下文（按业务 id 现查库的注入块：记忆 / 规则 / 滚动摘要 / 工作台快照）组装进本次 user 消息，且块要**随消息持久进历史**——落业务表、续跑链继承、前端按标记渲染全依赖历史里的内容。既有扩展面无处安放：`resolveSystemPrompt` 只装饰 system 侧（身份 / 纪律所在，数据混入会模糊「每轮不变的纪律 vs 每轮变的数据」边界），而「随 user 消息进历史」的注入块此前无任何框架出口（8.0 前的 reminders 注入通道不进历史本体或不随结果导出，已整线移除）。派发侧已有 `resolveSubAgentInput`（交接单附件通道）证明「输入组装可插槽化」，本钩子补上根调用这一层的对偶面——业务声明「怎么组装」（供数、块清单、顺序、收尾形态全是业务决策），框架统一「何时调用」（run 入口）与「产物去向」（进历史、随结果导出）。分层取向与 7.5.0 一致：块语义 / 落库 / 前端渲染留在业务层，框架不收编内容。

语义细则：

| 项 | 语义 |
| --- | --- |
| 调用时机 | 仅 `buildLoopConfig` 内、`agentName` 解析与注册校验之后调用；仅 `depth === 1` 的根调用且传入非空 `input` 时触发——纯续跑（`options.messages` + 无 `input`）不触发；sub-agent 派发路径（`executeSubAgent` → `subAgent.run`，depth ≥ 2）不触发 |
| 对偶互斥 | 派发侧组装走 `resolveSubAgentInput`、根调用侧组装走本钩子——同一次 run 内两者至多各触发一次、互不叠加（派发调用的子循环 depth ≥ 2，本钩子恒不触发；根调用的本钩子先于任何派发发生） |
| 参数 | `agentName` 为本次调用的 agent 名（`options.agent`，多 agent 应用按名路由组装逻辑）；`input` 为原始非空 user 输入；`ctx` 为 `deps.ctx` 请求上下文透传（与鉴权钩子 / 派发钩子同款） |
| 替换语义 | 返回非空字符串 → **整体替换**本次 user 输入（不与原 input 拼接——业务需要保留原文自行拼接）；典型形态：请求级动态块在前 + `<user_input>` 真实输入收尾（包裹格式业务自定） |
| 放行规则 | 返回 `undefined` → 原样放行（input 不变） |
| 形状守卫 | 返回非 `undefined` 且非非空字符串（`null` / 数字 / 对象 / 空串 / 空白串）→ 抛 `AgentError`（含钩子名与 agentName 的可行动错误信息，fail fast——业务代码 bug 不静默忽略；空白串按空处理，避免续跑轮输入被静默丢弃） |
| 产物去向 | 组装产物即 `reactLoop`/`reactLoopStream` 收到的 `input`——fresh run 成为首条 user 消息、续跑 run 成为历史末尾追加的新 user 消息，**均持久进循环历史**并随 `result.messages` / `done.messages` 导出（业务落库、续跑链继承、前端渲染全链可见） |
| trace 一致 | 组装发生在循环启动前——trace 的 `inputSnapshot` 如实反映组装后的 LLM 输入（与「trace 如实反映发送内容」纪律一致） |
| 错误传播 | 抛错原样上抛，走 run / stream 既有错误链（发起 LLM 请求前显式失败，不吞不降级——与 `resolveSystemPrompt` 同路径，无 per-tool 回灌语义） |
| 树级传导 | deps 全树共享，但仅根调用触发（depth 1）——子代理经 `resolveSubAgentInput` 组装派发入参，两钩子各司其职 |
| 流式一致 | 流式 / 非流式同一接线（`buildLoopConfig` 单点应用，run / stream 共用） |

使用示例（编程式组装 / 自组装 `overrides`）：

```ts
import { Agent, createAgentDeps } from '@faapi/agent';

const agent = new Agent(
  createAgentDeps({
    registries: ctx.registries,
    overrides: {
      resolveRootInput: async (agentName, input, ctx) => {
        if (agentName !== 'chapter-writer') return undefined; // 按 agent 名路由
        // 请求级现查库供数,块在前 + 真实输入收尾;包裹/顺序/收尾形态全是业务决策
        const blocks = await buildContextBlocks(input, ctx?.currentUserId);
        return [...blocks, `<user_input>\n${input}\n</user_input>`].join('\n\n');
      },
    },
  }),
);

// 每轮对话:组装产物作为新 user 消息进历史,随 result.messages 导出 → 业务落库 →
// 续跑轮经 options.messages 传回,块随历史继承
const result = await agent.run(userInput, { agent: 'chapter-writer', messages: history });
await persistMessages(result.messages);
```

### sub-agent 派发工具命名（subAgentToolName）

sub-agent 包装为 tool 发给 LLM 时,`function.name` 受 OpenAI 兼容协议硬约束 `^[a-zA-Z0-9_-]+$`（DeepSeek / OpenAI 等强校验上游对非法字符整单 400）。命名规则由主包 [subAgentToolName](../../faapi/src/injection/subAgentToolName.md) 统一：

- **派发名 = `agent-<agentName>`**——前缀 `agent-`（旧版 `agent.` 点号前缀违反协议,已废弃）
- agent 名本身须合法：文件型 agent 由 [scanAgents](../../faapi/src/agents/scanAgents.md) 目录段字符集校验保证（段内 `[a-zA-Z0-9-]`,`_` 为嵌套分隔符,如 `easy-writing_wizard`）
- **执行路由不按前缀猜测**——`buildLoopConfig` 时建立「派发名 → agent 名」映射（`agentToolNames`）与常规 tool 声明集合（`declaredTools`）两个结构,`executeTool` 按声明来源路由：真工具 `agent-foo`（即使注册表存在、甚至声明了）与 sub-agent `foo` 的派发名 `agent-foo` 不会互相误伤
- **构建期冲突显式抛 `AgentError`**：某 sub-agent 的派发名与该 agent 声明的常规 tool 名相同（如声明了 tool `agent-writer` 又声明 sub-agent `writer`）→ 抛错要求改名——静默遮蔽会让其中一方不可达

`authHooks` 的 `beforeToolCall` / `afterToolCall` 收到的 sub-agent 名即派发工具名（`agent-<name>`）,业务方用主包导出的 `SUB_AGENT_TOOL_PREFIX` 判别前缀,不硬编码字符串。

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

// 派发入参改写钩子:校验通过后、user 消息构造之前异步改写 args——返回对象整体
// 替换(合成物不受 Input schema 约束),undefined 原样放行;抛错原样上抛(per-tool
// catch 回传 LLM)。先于 resolveSubAgentContext,后续消费点均见最终 args
const rewritten = await deps.resolveSubAgentInput?.(subName, callArgs, deps.ctx);
if (rewritten !== undefined) {
  if (typeof rewritten !== 'object' || rewritten === null || Array.isArray(rewritten)) {
    throw new AgentError(...);        // 非法返回形状显式失败,不静默忽略
  }
  callArgs = rewritten;
}

// 派发上下文钩子:校验通过后异步供数,产出注入本实例（buildLoopConfig 追加进
// 子代理 system 消息）;undefined/空串跳过,抛错原样上抛（per-tool catch 回传 LLM）
subAgent.subAgentContextBlock = await deps.resolveSubAgentContext?.(subName, callArgs, deps.ctx);

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
- **派发入参校验（富 schema 模式）**：sub 元数据声明 `inputTypeName`（handler.ts 顶层 `Input` 导出,见「派发入参 schema 声明」）且 `deps.resolveAgentInputSchema` 已接线时,执行前 `validate(args)`——失败返回 `{ error }` 回灌主控 LLM 重试（与常规 tool 校验失败同语义,不进入子循环）;通过后以 coerce 后的 value 继续传导。解析结果 `undefined`（声明了但 zod.js 缺失/损坏）抛 `AgentError` 显式失败。resolver 未接线（编程式组装/测试）或未声明 `Input` 时跳过校验,行为与历史版本一致
- **派发上下文钩子**：`deps.resolveSubAgentContext` 已接线时,校验通过后以 `(subName, args, ctx)` 调用（args 为 coerce 后值）,返回值注入本子 Agent 实例——子循环 `buildLoopConfig` 在 `resolveSystemPrompt` 结果之后以 `\n\n` 追加为最终 system 消息（见「resolveSubAgentContext 派发上下文钩子」）。未接线 / 返回 `undefined` / 空串时逐字节现状
- **派发入参改写钩子**：`deps.resolveSubAgentInput` 已接线时,校验通过后、`resolveSubAgentContext` 之前以 `(subName, args, ctx)` 调用（args 为 coerce 后值）,返回普通对象整体替换 args——改写结果经 `extractSubAgentUserInput` 构造子代理首条 user 消息（交接单附件）,`resolveSubAgentContext` / `afterToolCall` 消费的也是改写后 args（见「resolveSubAgentInput 派发入参改写钩子」）。未接线 / 返回 `undefined` 时逐字节现状;返回非法形状抛 `AgentError`
- **`getAgentEntry` vs `getAgent`**：`getAgentEntry` 返回 `AgentMetadata`（含 `filePath` + `inputTypeName`）,`getAgent` 返回 `AgentCore`。两者都仅查文件 registry。sub-agent 必须是文件型 agent
- **默认 reactLoop + provider 继承**：sub-agent 统一走默认循环,调 `subAgent.run(input, { agent, provider, model, enableTracing })`——继承父调用解析出的 provider 与 model（外部 provider 或 llms 解析结果;config.model 已移除,sub 无自身 model 可声明,恒沿用父调用解析结果）。user 消息的提取规则：args 恰为单字段 `{ input: <string> }`（与默认入参 schema 形状一致）时直传 `input` 字符串;其余形状（宽松模型多传字段 / 传空对象 / 老客户端任意 JSON）`JSON.stringify(args)` 兜底,不丢信息、向后兼容。`enableTracing=true` 时 subAgent.run 返回的 `result.trace`（agentName 已被 `Agent.run` 填为 subName）附在 `SubAgentToolResult` 的 `trace` 字段返回给 reactLoop,reactLoop 识别后发出 `subagent_call` 事件,嵌入 sub-trace（递归结构,业务方可还原完整调用树）。`usage` / `turns` 字段始终携带（子循环整树口径,reactLoop 上卷进父 run 台账,详见 [reactLoop.md](./reactLoop.md)「usage 与 turns 的整树口径」）。`usage` / `turns` 缺省（如 provider 不返回用量）时 reactLoop 跳过对应累加

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
    if (chunk.traceEvent) sse.send({ event: 'trace', data: chunk.traceEvent });
    if (chunk.done) sse.send({ event: 'done', data: chunk.done });
  }
  sse.close();
}
```

**sub-agent 嵌套调试**：父 agent 调 sub-agent 时,sub-agent 的 trace 自动嵌入父 trace 的 `subagent_call` 事件（`enableTracing=true` 时,详见 [trace.md](./trace.md) 的「sub-agent 嵌套 trace」章节）,业务方可还原完整调用树。

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
- [promptTemplate](./promptTemplate.md) —— 提示词模板渲染（config 的 `vars` 静态声明）,`resolveSystemPrompt` 内 base 解析后调用
- [agentScope](./agentScope.md) —— 执行作用域（`getAgentScope`）,挂载点在 `Agent.run`/`stream` 入口,sub 换栈经 executeSubAgent 委托链统一发生
- [trace](./trace.md) —— Tracing 类型与文档（`AgentTrace` / `AgentTraceEvent` / `TracingToolResult`）,Agent 类是其「接线层」（填 agentName + 包装 sub-agent 返回值）
- [reactLoop.md](./reactLoop.md)「usage 与 turns 的整树口径」—— `SubAgentToolResult` 的上卷语义与边界
- [provider](./provider.md) —— Phase 3.2,Agent 构造时持有 `providers` Map（由 plugin 从 `config.agent.llms` 遍历调 `createProvider` 创建）
- faapi 核心 [agentRegistry](../../faapi/src/injection/agentRegistry.md) —— `AgentDeps` 访问器的真实实现来源（Phase 3.5 接线）
- faapi 核心 [toolRegistry](../../faapi/src/injection/toolRegistry.md) —— tool 元数据查询
- faapi 核心 [loadToolModule](../../faapi/src/loaders/loadToolModule.md) —— 动态加载 tool handler
- faapi 核心 [agentTypes](../../faapi/src/agents/agentTypes.md) / [extractToolMetadata](../../faapi/src/ast/extractToolMetadata.md) —— agent/tool 元数据类型定义
