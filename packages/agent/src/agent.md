# agent

一句话概括：Agent 类——按 `agent.name` 查找元数据、组装 tool 列表（tools + sub-agent）、提供 `run` / `stream` / `asTool`,把 [reactLoop](./reactLoop.md) 与 faapi 核心的 agent/tool 注册表粘合起来,并在 sub-agent 递归时传递 `enableTracing` 包装 [TracingToolResult](./trace.md)。

## 为什么需要

[reactLoop](./reactLoop.md)（Phase 3.3）是纯循环引擎——它只接收 `ReactLoopConfig`（provider + systemPrompt + tools + executeTool + maxTurns），不关心 tool 从哪来、如何加载、sub-agent 如何递归。需要一个组件负责「组装 config」和「执行 tool」：

- **组装 tool 列表**——从 faapi 核心的 `agentRegistry.resolveAgentTools` + `resolveSubAgents` 合并出 `LLMToolDefinition[]`,带每个 tool 的 input schema（JSON Schema）
- **执行 tool**——`reactLoop` 调 `executeTool(name, args, enableTracing)` 时,Agent 路由：
  - 常规 tool → `loadToolModule` 加载 handler + 可选 input 校验 → 调用
  - `agent.` 前缀 → 递归构造 sub-agent 调用（含 `maxAgentDepth` 防护 + 传递 `enableTracing`）
- **递归防护**——`maxAgentDepth` 限制 agent 调用 agent 的深度,防止无限递归
- **自定义 run**——agent handler 导出 `run` 函数时,sub-agent 调用走自定义逻辑而非默认 reactLoop
- **tracing 接线**——`run` 返回后填充 `result.trace.agentName`（reactLoop 不知 agent 名）；sub-agent 调用时传递 `enableTracing` 并把返回的 sub-trace 包装为 [TracingToolResult](./trace.md),让 reactLoop 发出 `subagent_call` 事件

Agent 类把这些「胶水」逻辑集中在一处,reactLoop 保持纯函数。

## 使用场景

- **Phase 3.5 集成**：faapi 核心 agent 注入器构造 `Agent` 实例（注入真实注册表/加载器访问器），包装为 `AgentHandle`（含可调用 `run` / `stream`）注入到 handler 的 `agent` 参数
- **sub-agent 递归**：reactLoop 执行 `agent.<name>` tool 时,Agent 构造子 Agent（depth+1）并调其 `run`
- **agent-as-tool**：父 agent 通过 `asTool()` 把自身包装为 `AgentToolDescriptor`,加入 LLM 可见 tool 列表

## 设计

### 核心类型

| 类型 | 说明 |
| --- | --- |
| `AgentDeps` | Agent 运行时依赖（providers Map + defaultProvider + agentName + rootDir + config + 注册表/加载器访问器 + 可选 schema 解析器） |
| `AgentRuntimeConfig` | 全局 agent 配置覆盖（maxTurns / maxAgentDepth / enableTracing） |
| `ToolSchemaResolution` | tool schema 解析结果（jsonSchema 给 LLM + validate 给执行前校验） |
| `AgentRecursionError` | sub-agent 递归超 `maxAgentDepth` 时抛出 |
| `TracingToolResult` | sub-agent 调用的特殊返回值（`{ __trace: true, result, trace }`）,reactLoop 据此识别 sub-agent 调用并发出 `subagent_call` 事件。详见 [trace](./trace.md) |

### 依赖注入（DI）

Agent 类**不直接 import** faapi 核心的注册表/加载器,而是通过 `AgentDeps` 接收访问器函数。原因：

- **可测试**——测试传 mock 访问器,无需启动真实注册表（与 [reactLoop.test](./reactLoop.test.ts) 同构）
- **解耦**——Agent 类不依赖核心运行时模块,核心模块变化不影响 Agent 逻辑
- **phase 边界**——Phase 3.4 实现 Agent 类逻辑,Phase 3.5 注入真实访问器（核心导出注册表/加载器后接线）

`AgentDeps` 访问器签名与 faapi 核心对称：

| 访问器 | 对应核心模块 | 说明 |
| --- | --- | --- |
| `getAgent(name)` | [agentRegistry.getAgent](../../faapi/src/injection/agentRegistry.md) | 查 agent `AgentCore`（LLM 可见字段：`name` / `description` / `systemPrompt` / `tools` / `agents` / `model` / `maxTurns`）。仅查文件 registry,**不 fallback 到 skillRegistry**——skill 与 agent 职责正交不耦合 |
| `getAgentEntry(name)` | [agentRegistry.getAgentEntry](../../faapi/src/injection/agentRegistry.md) | 查 agent `AgentMetadata`（继承 `AgentCore` + `filePath` / `hasRun`）。仅查文件 registry,加载 `handler.js` 用 |
| `getTool(name)` | [toolRegistry.getTool](../../faapi/src/injection/toolRegistry.md) | 查 tool 元数据（filePath / functionName / inputTypeName） |
| `resolveAgentTools(name)` | [agentRegistry.resolveAgentTools](../../faapi/src/injection/agentRegistry.md) | agent 显式声明的 tools 引用（仅查文件 registry） |
| `resolveSubAgents(name)` | [agentRegistry.resolveSubAgents](../../faapi/src/injection/agentRegistry.md) | agent 可调用 sub-agent 列表（`AgentCore[]`,仅查文件 registry,skill 不参与 sub-agent 递归） |
| `loadToolModule(...)` | [loadToolModule](../../faapi/src/loader/loadToolModule.md) | 动态 import tool handler |
| `loadAgentModule(...)` | [loadAgentModule](../../faapi/src/loader/loadAgentModule.md) | 动态 import agent handler（签名 `(filePath, hasRun)`，仅取可选 `run` 函数） |
| `resolveToolSchema?(tool)` | Phase 3.5 实现 | tool input 的 JSON Schema + 校验函数（基于 `zod.js` + `z.toJSONSchema`） |

### `Agent` 类方法

```ts
class Agent {
  constructor(deps: AgentDeps, depth?: number);  // depth 默认 1（根 agent）
  async run(input: string, options?: AgentRunOptions): Promise<ReactLoopResult>;
  async *stream(input: string, options?: AgentRunOptions): AsyncIterable<ReactLoopStreamChunk>;
  asTool(): AgentToolDescriptor | undefined;
}
```

- `run(input, options?)` —— 组装 `ReactLoopConfig`（应用 `options` 覆盖）→ 调 `reactLoop(input, config)` → 填充 `result.trace.agentName = this.deps.agentName`（reactLoop 不知 agent 名）
- `stream(input, options?)` —— 组装 config（应用 `options` 覆盖）→ 调 `reactLoopStream(input, config)`（流式 chunk 含 `traceEvent`,不含顶层 `AgentTrace`,无需事后填 agentName）
- `asTool()` —— 把自身包装为 `AgentToolDescriptor`（`kind: 'agent'` / `name: 'agent.<name>'` / `metadata`）

`AgentRunOptions` 定义在 [agentHandle](./agentHandle.md),`model` 字段是字符串 key
（支持 llms key 精确匹配 / `provider/model` 一体化 / 纯 model 名三种形式）,允许本次调用
临时切换 provider + model + temperature + maxTokens + enableTracing,不修改 agent 自身状态——适用于
「按请求切模型 / provider」的运行时动态切换场景。详见 [agentHandle.md](./agentHandle.md)
的「`options.model` 字符串 key 解析规则」。

`options.enableTracing` 用于覆盖全局 tracing 配置（默认沿用 `config.agent.enableTracing`,
全局默认 `false`——opt-in）,详见 [trace](./trace.md) 的「触发机制」章节。

### config 组装流程

`run` / `stream` 内部先组装 `ReactLoopConfig`：

1. `getAgent(deps.agentName)` 取元数据,未注册抛 `AgentError`
2. `buildToolDefinitions()`（async,因 schema 解析）组装 `LLMToolDefinition[]`
3. config 字段优先级（高 → 低）：`options`（本次调用传入）> agent 元数据（`systemPrompt` / `model` / `maxTurns`）> 全局 `AgentRuntimeConfig` / `deps.defaultProvider`

| 字段 | options 覆盖 | agent 元数据 | 全局默认 |
| --- | --- | --- | --- |
| `provider` | `options.model` 解析出的 provider（key 含 provider 时） | — | `deps.defaultProvider`（`defaultLlm` 对应） |
| `model` | `options.model` 解析出的 model | `meta.model` | `defaultLlm` provider 的 models 第一个 |
| `temperature` | `options.temperature` | — | `LlmConfig.temperature`（provider 级透传） |
| `maxTokens` | `options.maxTokens` | — | `LlmConfig.maxTokens`（provider 级透传） |
| `maxTurns` | — | `meta.maxTurns` | `AgentRuntimeConfig.maxTurns` |
| `enableTracing` | `options.enableTracing` | — | `AgentRuntimeConfig.enableTracing`（默认 `false`） |

`options.model` 是字符串 key,解析规则见 [agentHandle.md](./agentHandle.md) 的「`options.model` 字符串 key 解析规则」。
不传 `options.model` 时用 `deps.defaultProvider` + agent 元数据 `config.model`（或该 provider 的 models 第一个）。

### `buildToolDefinitions()` —— tool 列表组装

合并两个来源（按 `name` 去重,先入者保留）：

1. **agent.tools 引用** —— `resolveAgentTools(agentName)` 返回 agent 显式声明的 `tools` 引用
2. **sub-agent** —— `resolveSubAgents(agentName)` 每个包装为 `agent.<name>`（input 为自由 schema `{ type: 'object' }`）

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
if (name.startsWith('agent.')) {
  return executeSubAgent(name.slice(6), args, enableTracing);  // sub-agent 递归（含 tracing）
}
const tool = getTool(name);
if (!tool) throw new Error(`Tool "${name}" not found`);
// 可选 input 校验（复用 buildToolDefinitions 的 schema 缓存）
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

- **常规 tool 校验失败**：不抛错,返回 `{ error }` 对象——reactLoop 把它 stringify 后作为 tool 结果回传 LLM,LLM 可据此修正参数重试（与 [reactLoop](./reactLoop.md) 的「tool 错误回传 LLM」语义一致）
- **tool 未找到 / 加载失败**：抛错,被 reactLoop catch 后同样回传 LLM
- **`enableTracing` 参数**：由 [buildLoopConfig](#config-组装流程) 闭包捕获传入,用于 sub-agent 调用时决定是否包装 [TracingToolResult](./trace.md) 携带 sub-trace。常规 tool 不需要 tracing 包装,直接返回结果

### `executeSubAgent(subName, args, enableTracing)` —— sub-agent 递归

```ts
const newDepth = this.depth + 1;
const maxDepth = deps.config?.maxAgentDepth ?? DEFAULT_MAX_AGENT_DEPTH;
if (newDepth > maxDepth) throw new AgentRecursionError(maxDepth, newDepth);

const subAgent = new Agent({ ...deps, agentName: subName }, newDepth);

// 用 getAgentEntry 拿 AgentMetadata（含 filePath/hasRun）
const entry = deps.getAgentEntry(subName);
if (entry?.hasRun) {
  const mod = await deps.loadAgentModule(entry.filePath, entry.hasRun);
  if (mod.run) return await mod.run(args);  // 自定义 run,无 trace
}

// 默认 reactLoop:传递 enableTracing 让 sub-agent 采集 trace
const result = await subAgent.run(
  typeof args === 'string' ? args : JSON.stringify(args),
  { enableTracing },
);

// enableTracing=true:包装 TracingToolResult,reactLoop 据此发出 subagent_call 事件
if (enableTracing && result.trace) {
  return { __trace: true, result: result.content, trace: result.trace };
}
return result.content;  // enableTracing=false:直接返回,与常规 tool 一致
```

- **`maxAgentDepth`**：默认 3。depth 从 1（根）开始,sub-agent 为 2、3...,超出抛 `AgentRecursionError`
- **`getAgentEntry` vs `getAgent`**：加载 `handler.js` 必须用 `getAgentEntry`——`getAgent` 返回 `AgentCore`（无 `filePath` / `hasRun`）。两者都仅查文件 registry,不 fallback 到 skillRegistry（skill 与 agent 职责正交不耦合,skill 不参与 sub-agent 递归）。sub-agent 必须是文件型 agent,skill 不被 `agents` 列表自动引用
- **自定义 run**：sub-agent handler 导出 `run` 时（`entry.hasRun=true`）,调用 `mod.run(args)` 跳过默认 reactLoop——业务方完全控制 sub-agent 逻辑,**无 trace**（业务方自己返回业务结果,不参与 reactLoop 的 tracing 采集）
- **默认 reactLoop + tracing**：sub-agent 无 `run`（未注册或 `hasRun=false`）时,调 `subAgent.run(stringify(args), { enableTracing })`——agent-as-tool input 为开放式 JSON,stringify 后作为 user 消息喂给 sub-agent 的 LLM。`enableTracing=true` 时 subAgent.run 返回的 `result.trace`（agentName 已被 `Agent.run` 填为 subName）被包装为 `TracingToolResult` 返回给 reactLoop,reactLoop 通过 `isTracingToolResult` 识别后发出 `subagent_call` 事件,嵌入 sub-trace（递归结构,业务方可还原完整调用树）。`enableTracing=false` 时返回 `result.content`（与常规 tool 一致,零开销）

### Tracing

Agent 类是 [trace](./trace.md) 的「接线层」——reactLoop 只关心循环逻辑,不知道：

- **agent 名**：`reactLoop` 返回的 `result.trace.agentName` 是空字符串。`Agent.run` 在 reactLoop 返回后填充 `result.trace.agentName = this.deps.agentName`（sub-agent 调本方法时也走此路径,subAgent.run 返回的 trace.agentName 自动是 subName）
- **常规 tool vs sub-agent**：reactLoop 只调 `executeTool(name, args, enableTracing)`,不区分。Agent 在 `executeSubAgent` 中根据 `enableTracing` 决定返回值——`true` 时返回 `TracingToolResult`（reactLoop 据此发 `subagent_call` 事件,嵌入 sub-trace）；`false` 时返回 `result.content`（reactLoop 发 `tool_call` 事件,零开销）

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
| tool 未找到 / 加载失败 | `Error` | 抛错,被 reactLoop catch 后回传 LLM |
| tool input 校验失败 | 返回 `{ error }` | 不抛错,作为 tool 结果回传 LLM 重试 |
| LLM provider 抛错 | 透传 | reactLoop 不 catch,立即传播 |

### `asTool()` —— agent 包装为 tool

```ts
asTool(): AgentToolDescriptor | undefined {
  const meta = deps.getAgent(deps.agentName);
  if (!meta) return undefined;
  return {
    kind: 'agent',
    name: `agent.${meta.name}`,
    agentName: meta.name,
    description: meta.description,
    metadata: meta,
  };
}
```

与 [agentRegistry.asTool](../../faapi/src/injection/agentRegistry.md) 同构——Agent 类自带此方法便于在注入器场景直接调用（不必再过注册表）。

## 相关模块

- [reactLoop](./reactLoop.md) —— Phase 3.3,Agent 的 `run`/`stream` 委托给它
- [trace](./trace.md) —— Tracing 类型与文档（`AgentTrace` / `AgentTraceEvent` / `TracingToolResult`）,Agent 类是其「接线层」（填 agentName + 包装 sub-agent 返回值）
- [provider](./provider.md) —— Phase 3.2,Agent 构造时持有 `providers` Map + `defaultProvider`（由 plugin 从 `config.agent.llms` 遍历调 `createProvider` 创建）
- faapi 核心 [agentRegistry](../../faapi/src/injection/agentRegistry.md) —— `AgentDeps` 访问器的真实实现来源（Phase 3.5 接线）
- faapi 核心 [toolRegistry](../../faapi/src/injection/toolRegistry.md) —— tool 元数据查询
- faapi 核心 [loadAgentModule](../../faapi/src/loader/loadAgentModule.md) / [loadToolModule](../../faapi/src/loader/loadToolModule.md) —— 动态加载 handler
- faapi 核心 [extractAgentMetadata](../../faapi/src/ast/extractAgentMetadata.md) / [extractToolMetadata](../../faapi/src/ast/extractToolMetadata.md) —— 元数据类型定义
