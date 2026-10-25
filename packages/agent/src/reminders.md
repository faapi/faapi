# reminders（agent 提醒注入）

一句话概括：在 agent 对话的 user 消息上注入 `<system-reminder>` 包裹的上下文提醒，支持全局 / 单 agent 两个声明面与 once（首轮持久）/ everyTurn（每轮刷新）两个通道。

## 为什么需要

agent 运行中存在一类「框架注入的上下文」：不是用户说的话，也不是系统人格（systemPrompt），而是随执行状态变化或随声明固定的提醒——todo 状态、记忆快照、日期环境、输出规范等。它们的特征：

- **与 systemPrompt 正交**：systemPrompt 每 run 解析一次且持久于循环历史，做不到「tool 执行后下一轮立刻刷新」；reminder 的价值恰是新鲜状态快照 + 近因位置
- **不应污染对话语义**：模型视角里它是 harness 生成的可信上下文，不应进 assistant/user 的对话历史本体（everyTurn 通道）
- **不应逐轮重复付费**：固定规则、日期这类 run 期不变的内容，每轮重注入是纯浪费（once 通道）

## 使用场景

- 全局固定提醒：`config.agent.reminders: ['所有输出必须带引用来源']`（once）
- 全局动态状态：`config.agent.reminders: [async ({ turn }) => turn > 1 ? renderTodoState() : undefined]`（everyTurn）
- 单 agent 提醒：agent config 块 `reminders: ['禁止编造数据']` 或 builder 函数（与全局声明面同构的完整 ReminderSpec 形态，启动期求值）
- 隔离任务路径：agent 循环收敛宿主执行（单次 agent-run RPC），reminders 渲染全在宿主（业务函数零跨线程）

## 语义规格

### 声明面与类型

类型定义在主包 `configs/configTypes.ts`（与 `AgentConfig` 同侧，供声明面与 agent 包共用）：

```ts
type ReminderPhase = 'once' | 'everyTurn';
interface ReminderInfo {
  agentName: string;   // 触发渲染的 agent 名（root 或 sub-agent 均为其自身名）
  depth: number;       // agent 嵌套深度（root = 0）
  turn: number;        // once 固定 0；everyTurn 为当轮序号（1 起）
  ctx: AgentToolContext;
}
type ReminderBuilder = (info: ReminderInfo) => string | null | undefined | Promise<string | null | undefined>;
interface ReminderSpecObject { when?: ReminderPhase; content: string | ReminderBuilder; }
type ReminderSpec = string | ReminderBuilder | ReminderSpecObject;
```

两个声明面：

1. **全局**：`config.agent.reminders?: ReminderSpec[]` → `AgentConfig.reminders` → `toAgentRuntimeConfig` → `AgentRuntimeConfig.reminders`（新旋钮两路自动到达的既有清单）
2. **单 agent**：agent config 块 `reminders?: ReminderSpec[]` → 启动期求值进 `AgentCore.reminders`（与全局声明面**同构**——string / builder 函数 / `{ when, content }` 对象全形态支持，求值与校验见主包 [loadAgents.md](../../faapi/src/agents/loadAgents.md)）。单 agent 声明不降级为 once-only，与全局声明面能力等价；合并时排在其后（更靠近上下文末端）

### when 解析与合并

- `string` → `once`；函数 → `everyTurn`；对象形式 `when` 显式覆盖（默认按 content 形态：string→once、函数→everyTurn）
- 合并顺序：全局声明在前、单 agent 在后（agent 特定内容更靠近上下文末端）；各自保持声明序

### 两通道注入规则

**once（首轮持久）**：

- 仅 fresh run（未传 `options.messages`）时渲染一次（builder 可 async），追加到初始 user 消息 content 末尾（`\n\n` 连接），**持久写进循环历史**
- 续跑（`options.messages`）不注入——历史已带或对话早于配置，重注入会重复
- 持久内容视为普通历史：受裁剪/压缩影响（旧提醒自然老化，合理）；计入 token 预算估算

**everyTurn（每轮刷新）**：

- 每轮 LLM 请求前渲染（在 `resolveOutgoingMessages` 裁剪/压缩**之后**），追加到发送副本**末条 user 消息** content 末尾；本地循环历史不变
- 不占 token 预算、不被裁剪、无过期副本；无 user 消息（纯续跑边角）跳过注入
- 追加发生在 trace inputSnapshot 之前——trace 如实反映发给 LLM 的内容

**包裹格式**：每条渲染内容各自包裹 `<system-reminder>\n{content}\n</system-reminder>`，多条 `\n\n` 连接；builder 返回 `undefined`/`null`/trim 后空串 → 该条本轮跳过；全部为空 → 不追加任何内容。

### 错误语义（fail fast）

- builder 抛错 → 包 `AgentError`（含 agent 名 / phase / 声明序号）中止本次 run/stream——与 systemPromptFile 读取失败同款，不静默降级
- builder 返回非 string/undefined/null → 包 `AgentError`（返回类型违约）
- 渲染函数对传入 spec 形态违约（非三种合法形态）→ 包 `AgentError`

### 运行时装配（buildLoopConfig，单一装配点）

```
deps.resolveReminders 已接线（业务 decorateDeps）
  → 钩子是唯一供数源：本地 specs（config.reminders + meta.reminders）整体忽略（避免双渲染）
  → createHookReminderResolver(hook, { agentName, depth, ctx: deps.ctx })
否则
  → specs = collectReminderSpecs(deps.config?.reminders, meta.reminders)
  → specs 非空：createSpecReminderResolver(specs, { agentName, depth, ctx: deps.ctx })；空：不传
```

钩子签名（AgentDeps 级，与 resolveSubAgentInput/Context 同层）：

```ts
resolveReminders?: (
  info: ReminderInfo & { phase: ReminderPhase },
) => Promise<string[] | undefined>;
```

返回该 phase 的**未包裹内容串数组**（包裹由引擎统一做）；`undefined` = 本 phase 无提醒。

### reactLoop 消费面

`ReactLoopConfig.reminders?: ReminderResolver`——循环层只认识解析器，不认识 ReminderSpec（保持循环层纯消息管线）：

```ts
interface ReminderResolver {
  /** fresh run 时调用一次；返回完整包裹块（undefined = 不注入） */
  once: () => Promise<string | undefined>;
  /** 每轮请求前调用；返回完整包裹块（undefined = 不注入） */
  everyTurn: (turn: number) => Promise<string | undefined>;
}
```

### 隔离任务路径（循环收敛宿主）

config 级声明（`config.agent.reminders`）可含函数，不可跨线程——agent 循环已收敛宿主执行（单次 `agent-run` RPC），reminders 渲染随之全在宿主，无需任何 RPC 垫片：

```
worker 内 taskCtx.agent.run(input, options)
  → 单次 agent-run RPC（纯数据请求）
宿主 taskQueue onAgentRun → agentRunner.runAgent(agentHostCtx, request, { signal })
  → plugin.ts runAgent：new Agent({ ...baseDeps, ctx: agentHostCtx }).run(runInput, { ...options, agent: agentName, signal })
    → 完整循环在宿主（LLM IO、tool 执行、钩子、reminders 渲染、sub-agent 递归）
```

- **真实声明全量可见**：baseDeps 携带 config.reminders 与注册表——builder 函数在宿主按原生路径渲染（agentName/depth/ctx 均为真实值），不经任何序列化
- 宿主 ctx 不跨线程：worker 不传 ctx，宿主以任务合成契约 ctx（agentHostCtx，carry 身份落顶层）调用 builder
- 快照仅服务 worker 侧只读查询：`AgentSnapshotRecord` 投影将 reminders **整体剥离**（builder 不可克隆）——隔离侧查询拿不到提醒声明是快照语义的一部分，渲染本身在宿主不受影响
- sub-agent 递归：循环在宿主，派发的子代理共享同一 deps——钩子路径 agentName/depth 为 sub 自身值，meta.reminders 在 buildLoopConfig 本地合并

## 相关模块

- `configs/configTypes.ts`（主包）- ReminderSpec 类型族定义 + AgentConfig.reminders 声明面
- `agent.ts` - AgentRuntimeConfig.reminders 旋钮 + AgentDeps.resolveReminders 钩子 + buildLoopConfig 装配
- `agentDeps.ts` - toAgentRuntimeConfig 拆装清单新增 reminders
- `reactLoop.ts` - ReactLoopConfig.reminders 消费（initLoop once 注入 / 每轮 everyTurn 追加）
- `plugin.ts` - agentRunner 注册 runAgent（宿主完整循环，reminders 渲染在宿主原生执行）
- `../faapi/src/agents/loadAgents.ts`（主包）- AgentCore.reminders 启动期求值与校验
- `../faapi/src/cli/generateAgentArtifacts.ts`（主包）- 定位清单生成（reminders 不进清单——函数形态不可序列化，求值在启动期）
- `../faapi/src/injection/registries.ts`、`../faapi/src/tasks/taskQueue.ts`、`../faapi/src/tasks/taskWorker.ts`（主包）- AgentRunner 接口 / onAgentRun 注入 / agent-run RPC 协议
- `../faapi/src/tasks/taskTypes.ts`（主包）- AgentSnapshotRecord 投影：reminders 整体剥离（循环在宿主，快照仅服务 worker 只读查询）
