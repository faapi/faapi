# reminders（agent 提醒注入）

一句话概括：在 agent 对话的 user 消息上注入 `<system-reminder>` 包裹的上下文提醒——**`resolveReminders` deps 级钩子是唯一供数入口**，引擎提供 once（首轮持久）/ everyTurn（每轮刷新）两个注入通道。

> **8.0 起 spec 声明面已移除**：全局 `config.agent.reminders` 与单 agent config 块 `reminders` 字段（`ReminderSpec` 三形态）不再存在，声明即撞 config 白名单报错。收敛建议来自业务方选型评估（TODO-faapi-gaps 2026-10-26）：双通道声明面各自只覆盖一半「新鲜且持久」诉求（once 持久但续跑轮冻结首轮快照、everyTurn 逐轮新鲜但只改发送副本不进历史），与「按调用现查库的动态注入」错位；钩子接线后本地声明被静默忽略、钩子路径防护弱于 spec 路径的不对称也不再成立。动态注入块请走 `resolveRootInput`（根调用）/ `resolveSubAgentInput`（派发）——两者产物进循环历史，落库 / 前端渲染 / 续跑链继承全链可见；reminders 钩子承接「不进历史本体的每轮新鲜提醒」。

## 为什么需要

agent 运行中存在一类「框架注入的上下文」：不是用户说的话，也不是系统人格（systemPrompt），而是随执行状态变化的提醒——todo 状态、记忆快照、日期环境、输出规范等。它们的特征：

- **与 systemPrompt 正交**：systemPrompt 每 run 解析一次且持久于循环历史，做不到「tool 执行后下一轮立刻刷新」；reminder 的价值恰是新鲜状态快照 + 近因位置
- **不应污染对话语义**：模型视角里它是 harness 生成的可信上下文，不应进 assistant/user 的对话历史本体（everyTurn 通道）
- **不应逐轮重复付费**：固定规则、日期这类 run 期不变的内容，每轮重注入是纯浪费（once 通道）

供数收敛为钩子的原因：供数时机与形态（现查库、按调用组装）天然是业务知识，框架声明面只能覆盖静态串与简单 builder 两类边角；钩子让「何时注入」（框架）与「供什么」（业务）各归其位。

## 使用场景

- 业务 `decorateDeps` 接线（`createAgentDeps` overrides 或 `config.agent.decorateDeps`）：`resolveReminders` 按调用现查库渲染提醒
- 隔离任务路径：agent 循环收敛宿主执行（单次 agent-run RPC），reminders 渲染全在宿主（业务函数零跨线程）

## 语义规格

### 类型（定义在主包 `configs/configTypes.ts`，供声明面与 agent 包共用）

```ts
type ReminderPhase = 'once' | 'everyTurn';
interface ReminderInfo {
  agentName: string;   // 触发渲染的 agent 名（root 或 sub-agent 均为其自身名）
  depth: number;       // agent 嵌套深度（root = 0）
  turn: number;        // once 固定 0；everyTurn 为当轮序号（1 起）
  ctx: AgentToolContext;
}
```

### 钩子签名（AgentDeps 级，与 resolveSubAgentInput/Context 同层）

```ts
resolveReminders?: (
  info: ReminderInfo & { phase: ReminderPhase },
) => Promise<string[] | undefined>;
```

返回该 phase 的**未包裹内容串数组**（包裹由引擎统一做）；`undefined` = 本 phase 无提醒。

- deps 全树共享——一次接线覆盖 root 与全部可达子代理（`agentName`/`depth` 各自值）
- `ctx` 为 `deps.ctx` 透传；worker 垫片不外传 ctx——宿主以任务合成 ctx 调用
- **错误语义（fail fast）**：钩子抛错 → 包 `AgentError`（含 agent 名与 phase）中止本次 run/stream，不静默降级；返回值非 `string[]`（非数组或数组含非 string 元素）→ 同样抛 `AgentError`（返回类型违约）

### 两通道注入规则

**once（首轮持久）**：

- 仅 fresh run（未传 `options.messages`）时调用一次（phase=`'once'`、turn=0），追加到初始 user 消息 content 末尾（`\n\n` 连接），**持久写进循环历史**
- 续跑（`options.messages`）不注入——历史已带或对话早于配置，重注入会重复
- 持久内容视为普通历史：受裁剪/压缩影响（旧提醒自然老化，合理）；计入 token 预算估算

**everyTurn（每轮刷新）**：

- 每轮 LLM 请求前调用（phase=`'everyTurn'`、turn 为当轮序号 1 起；在 `resolveOutgoingMessages` 裁剪/压缩**之后**），追加到发送副本**末条 user 消息** content 末尾；本地循环历史不变
- 不占 token 预算、不被裁剪、无过期副本；无 user 消息（纯续跑边角）跳过注入
- 追加发生在 trace inputSnapshot 之前——trace 如实反映发给 LLM 的内容

**包裹格式**：每条渲染内容各自包裹 `<system-reminder>\n{content}\n</system-reminder>`，多条 `\n\n` 连接；空数组/全部为空 → 不追加任何内容。包裹为原样插值不做转义——内容含闭合标签字面量时由业务供数侧自行转义（如全角替换）。

### reactLoop 消费面

`ReactLoopConfig.reminders?: ReminderResolver`——循环层只认识解析器，不认识供数来源（保持循环层纯消息管线）：

```ts
interface ReminderResolver {
  /** fresh run 时调用一次；返回完整包裹块（undefined = 不注入） */
  once: () => Promise<string | undefined>;
  /** 每轮请求前调用；返回完整包裹块（undefined = 不注入） */
  everyTurn: (turn: number) => Promise<string | undefined>;
}
```

### 运行时装配（buildLoopConfig，单一装配点）

```
deps.resolveReminders 已接线 → createHookReminderResolver(hook, { agentName, depth, ctx: deps.ctx })
未接线 → 不装配 reminders（无供数源即无注入）
```

### 隔离任务路径（循环收敛宿主）

agent 循环已收敛宿主执行（单次 `agent-run` RPC），reminders 渲染随之全在宿主，无需任何 RPC 垫片：

```
worker 内 taskCtx.agent.run(input, options)
  → 单次 agent-run RPC（纯数据请求）
宿主 taskQueue onAgentRun → agentRunner.runAgent(agentHostCtx, request, { signal })
  → plugin.ts runAgent：new Agent({ ...baseDeps, ctx: agentHostCtx }).run(runInput, { ...options, agent: agentName, signal })
    → 完整循环在宿主（LLM IO、tool 执行、钩子、reminders 渲染、sub-agent 递归）
```

- 钩子在宿主按原生路径执行（agentName/depth/ctx 均为真实值），不经任何序列化
- 宿主 ctx 不跨线程：worker 不传 ctx，宿主以任务合成契约 ctx（agentHostCtx，carry 身份落顶层）调用钩子
- sub-agent 递归：循环在宿主，派发的子代理共享同一 deps——钩子路径 agentName/depth 为 sub 自身值

## 相关模块

- `configs/configTypes.ts`（主包）- ReminderPhase / ReminderInfo 类型定义
- `agent.ts` - AgentDeps.resolveReminders 钩子 + buildLoopConfig 装配
- `reactLoop.ts` - ReactLoopConfig.reminders 消费（initLoop once 注入 / 每轮 everyTurn 追加）
- `plugin.ts` - agentRunner 注册 runAgent（宿主完整循环，reminders 渲染在宿主原生执行）
- `../faapi/src/injection/registries.ts`、`../faapi/src/tasks/taskQueue.ts`、`../faapi/src/tasks/taskWorker.ts`（主包）- AgentRunner 接口 / onAgentRun 注入 / agent-run RPC 协议
- `agent.md` - resolveRootInput / resolveSubAgentInput（进历史的动态注入块走这两条对偶钩子）
