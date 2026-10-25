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
- 单 agent 固定提醒：agent config 块 `reminders: ['禁止编造数据']`（once，构建期字面量提取）
- 隔离任务路径：worker 内 agent 循环经 RPC 由宿主渲染提醒（业务函数零跨线程）

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
2. **单 agent**：agent config 块 `reminders?: string[]` → 构建期字面量提取进 `AgentCore.reminders`（与 tools/agents 同管线，含非字面量元素构建期抛错）→ 清单序列化透传。**单 agent 声明全部为 once**（静态文本，AST 提取只能给字面量）

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
deps.resolveReminders 已接线（worker RPC 垫片 / 业务 decorateDeps）
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

### 隔离任务路径（动态函数的宿主桥接）

config 级声明（`config.agent.reminders`）可含函数，不可跨线程——复用既有 RPC 配方（与 beforeToolCall 同款，业务函数零跨线程）：

```
worker buildAgentChannel
  → overrides 注入 resolveReminders RPC 垫片（ctx 参数不外传）
  → rpc('resolve-reminders', { agentName, depth, turn, phase })
宿主 taskQueue onAgentCall 分派 → AgentToolRunner.resolveReminders
  → plugin.ts 处理器：全量合并（baseDeps.config?.reminders + baseDeps.getAgent(agentName)?.reminders）
    → renderReminderSpecs(specs, { ...info, ctx: agentHostCtx }, phase) → string[] 回传
```

- worker 侧 buildLoopConfig 因钩子接线走 hook 解析器——config 快照内被剔除函数的 specs 数组不消费（字符串占位 undefined 亦无影响）
- 宿主 ctx 不跨线程：worker 不传 ctx，宿主以任务合成 ctx（agentHostCtx）调用 builder
- 返回值 string[] 可结构化克隆 ✓
- sub-agent 派发（worker 内或宿主内）：新 Agent 共享 deps——钩子路径 agentName/depth 为 sub 自身值，合并点在宿主 handler；本地路径 buildLoopConfig 合并 sub 的 meta.reminders

## 相关模块

- `configs/configTypes.ts`（主包）- ReminderSpec 类型族定义 + AgentConfig.reminders 声明面
- `agent.ts` - AgentRuntimeConfig.reminders 旋钮 + AgentDeps.resolveReminders 钩子 + buildLoopConfig 装配
- `agentDeps.ts` - toAgentRuntimeConfig 拆装清单新增 reminders
- `reactLoop.ts` - ReactLoopConfig.reminders 消费（initLoop once 注入 / 每轮 everyTurn 追加）
- `plugin.ts` - agentToolRunner 注册 resolveReminders 处理器（宿主渲染 + 全量合并）
- `ast/extractAgentMetadata.ts`（主包）- AgentCore.reminders 构建期提取（requireStringArrayValue）
- `cli/generateAgentArtifacts.ts`（主包）- SerializedAgentRecord / serializeAgents / hydrateAgents 透传
- `injection/registries.ts`、`tasks/taskQueue.ts`、`tasks/workerEntry.ts`（主包）- AgentToolRunner 接口 / RPC 分派 / worker 垫片
- `tasks/configSnapshot.ts`（主包）- 快照投影规则：reminders 数组函数元素剔除（既有行为，worker 路径不消费快照内 specs）
