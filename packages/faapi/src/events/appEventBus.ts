import type { AgentToolContext } from '../runtime/agentToolContext';
import type { FaapiContext } from '../runtime/contextTypes';
import type { LLMMessage, LLMToolDefinition } from './llmMessageTypes';
import type { LifecycleContext } from '../configs/configTypes';
import type { TaskFailedInfo } from '../tasks/taskTypes';

/**
 * app 级事件总线（契约与事件目录见 [appEventBus.md](./appEventBus.md)）
 *
 * 业务方唯一订阅入口是 `getApp().on(name, handler)`（AppBase.on，委托本总线）；
 * `emit` 由框架内部经 `AppRegistries.appEvents` 调用（`@faapi/agent` 插件把它
 * 注入 agent deps 的 `emitAppEvent`）。
 *
 * 事件目录封闭强类型——事件名被 `FaapiAppEventName` 约束、handler 载荷由
 * `FaapiAppEventMap` 推导，目录外名字编译报错（无 unknown 逃逸口）。
 */

// ─── 事件载荷 ────────────────────────────────────────

/**
 * `agent:root-input` 载荷——本次对话的首条 user 消息（loop 首个用户输入的塑形出口）
 *
 * **不含 agent 名**：`agent:root-input` 与 `agent:root-input:<agentName>` 双订阅
 * 并存时，载荷里的 agent 名与专属事件名冗余（两条等价分流路径并存造成使用困惑）——
 * 按 agent 路由统一走专属名订阅（agent 名在事件名里），通用订阅是 agent 无关的横切处理。
 *
 * 写面只有 `addInput`，与 `agent:input` 共用同一条落账管道：root-input 在循环启动前
 * 暂存，片段与 loop 首轮 `agent:input` 的片段**一起**排序 / 过滤 / `'\n\n'` 拼接 /
 * `{{rawInput}}` 展开，合并落账为一条首条 user 消息（同 index 下 root-input 片段在前）。
 * `input` 只读——原输入恒在消息中（可包裹 / 重排，不可丢弃或改写原文），赋值抛 `TypeError`（getter-only）。
 */
export interface AgentRootInputEvent {
  /** 本次对话首条 user 输入原文（根调用为 run/stream 入参;子代理为派发入参提取产物）——只读 */
  readonly input: string;
  /**
   * 补充输入片段（循环启动前暂存，loop 首轮与 `agent:input` 片段一起落账进首条 user 消息）
   *
   * @param text 片段文本（框架不包裹不转义）。含 `{{rawInput}}` 占位符时占位符全部展开为
   *   `input` 原文（原输入嵌在订阅端指定位置、不再缀尾，如
   *   `'规则…\n\n<user_input>{{rawInput}}</user_input>'`）；不含占位符 → 片段前置 + 原输入缀尾
   * @param index 排序序号（与 `agent:input` 片段同一序列升序稳定排序；缺省 100）
   */
  addInput(text: string, index?: number): void;
  /** 请求上下文（HTTP 路径为请求收窄 ctx;任务路径为任务合成 ctx） */
  ctx: AgentToolContext;
}

/**
 * `agent:input` 载荷——每轮 LLM 调用前的历史编辑窗口（append-only 不可变账本）
 *
 * **不含 agent 名**（同 `AgentRootInputEvent` 口径）：按 agent 路由走
 * `agent:input:<agentName>` 专属名订阅，通用订阅是 agent 无关的横切处理。
 *
 * 写面只有 `addInput`：补充的文本片段在扇出结束后按 index 升序稳定排序（同 index
 * 保持调用序）、`'\n\n'` 拼接，前置进当轮输入消息（当轮无新输入的工具轮/纯续跑轮
 * 为新增 user 消息）——**落账进对话历史，后续轮次 / result.messages / 断点续跑链
 * 全部可见，落账即不可变**。loop 首轮与 `agent:root-input` 共用暂存、一起合并落账
 * （root-input 片段暂存更早，同 index 下在前）。`messages` 是深冻结只读快照，整体
 * 替换赋值抛 `TypeError`（历史不开放改写）。
 */
export interface AgentInputEvent {
  /** 递归深度（根循环 = 1） */
  depth: number;
  /** 历史只读快照（深冻结克隆，读取口径；任何写操作抛 TypeError） */
  readonly messages: readonly LLMMessage[];
  /**
   * 补充输入片段（本轮暂存，扇出结束后落账进历史）
   *
   * @param text 片段文本（框架不包裹不转义，`<system-reminder>` 等标签包裹是订阅端
   *   自己的事）。含 `{{rawInput}}` 占位符时：当轮有新输入 → 占位符全部展开为原输入
   *   内容（原输入嵌在订阅端指定位置、不再缀尾——片段产物与原输入互斥，位置由占位符
   *   裁决）；无当轮输入的轮（工具轮/纯续跑轮）展开为空串（展开后全空白不落账）；
   *   不含占位符 → 片段前置 + 原输入缀尾
   * @param index 排序序号（升序稳定排序，同 index 保持调用序；缺省 100——显式小号插前、
   *   大号插后；推荐留隙 10/20/30 便于后续插入不牵动既有序号）
   */
  addInput(text: string, index?: number): void;
  /** 请求上下文（同 AgentRootInputEvent.ctx） */
  ctx: AgentToolContext;
}

/**
 * `agent:history-over-budget` 载荷——历史超过 `maxHistoryTokens` 阈值，压缩由业务承接
 *
 * 框架不内置任何裁剪/压缩：本事件是历史长度控制的唯一承接面。业务调 `replace`
 * 用压缩产物**整体替换循环历史**（落账：后续轮次 / result.messages / 断点续跑链
 * 全部可见且不可变）；不调 = 历史原样发送。事件按轮估算、命中即发射、当轮至多
 * 一次；后续轮次重新估算、仍超限再发射。**不含 agent 名**（同 agent 域统一口径）。
 */
export interface AgentHistoryOverBudgetEvent {
  /** 递归深度（根循环 = 1） */
  depth: number;
  /** 框架估算的历史 token 数（字符数 / 2，中英混合保守值，不引入 tokenizer 依赖） */
  estimatedTokens: number;
  /** 触发本事件的 `maxHistoryTokens` 阈值 */
  budget: number;
  /** 当前历史只读快照（深冻结克隆，读取口径；写操作抛 TypeError） */
  readonly messages: readonly LLMMessage[];
  /**
   * 用压缩产物整体替换循环历史（落账；多 handler 后调覆盖先调；不调 = 原样发送）
   *
   * @param history 压缩后的完整历史——扇出结束后校验非空 + 消息角色合法 +
   *   `assistant.tool_calls` 与 tool 结果配对完整（与续跑历史同款约束），违反抛
   *   `AgentError` 且替换不生效
   */
  replace(history: LLMMessage[]): void;
  /** 请求上下文（同 AgentRootInputEvent.ctx） */
  ctx: AgentToolContext;
}

// ─── 事件目录（封闭,随框架版本演进）────────────────────

/**
 * 框架事件目录——封闭映射：精确名 + 模板字面量索引签名（`:<agentName>` 专属变体
 * 载荷与通用名同源）。业务自定义事件名不支持：目录封闭是「`on` 无 unknown」的前提,
 * 新框架事件随版本进本映射。
 */
export interface FaapiAppEventMap {
  'agent:root-input': AgentRootInputEvent;
  'agent:input': AgentInputEvent;
  'agent:history-over-budget': AgentHistoryOverBudgetEvent;
  'agent:before-tool-call': BeforeToolCallEvent;
  'agent:after-tool-call': AfterToolCallEvent;
  'agent:filter-tools': FilterToolsEvent;
  'agent:system-prompt': SystemPromptEvent;
  'agent:sub-agent-context': SubAgentContextEvent;
  'app:boot': LifecycleContext;
  'app:ready': LifecycleContext;
  'app:close': LifecycleContext;
  'request:error': RequestErrorEvent;
  'task:failed': TaskFailedInfo;
  [k: `agent:root-input:${string}`]: AgentRootInputEvent;
  [k: `agent:input:${string}`]: AgentInputEvent;
  [k: `agent:history-over-budget:${string}`]: AgentHistoryOverBudgetEvent;
  [k: `agent:before-tool-call:${string}`]: BeforeToolCallEvent;
  [k: `agent:after-tool-call:${string}`]: AfterToolCallEvent;
  [k: `agent:filter-tools:${string}`]: FilterToolsEvent;
  [k: `agent:system-prompt:${string}`]: SystemPromptEvent;
  [k: `agent:sub-agent-context:${string}`]: SubAgentContextEvent;
}

/** 框架事件名的全集（含 agent 专属变体模板） */
export type FaapiAppEventName = keyof FaapiAppEventMap;

/** 事件 handler：同步或异步,原地修改载荷实现改写 */
export type AppEventHandler<K extends FaapiAppEventName> = (
  payload: FaapiAppEventMap[K],
) => void | Promise<void>;

/** 事件发射器签名（`AgentDeps.emitAppEvent` / 总线 `emit` 同一形状） */
export type AppEventEmitter = <K extends FaapiAppEventName>(
  name: K,
  payload: FaapiAppEventMap[K],
) => Promise<FaapiAppEventMap[K]>;

// ─── agent 工具链 / systemPrompt / 派发上下文载荷 ────
//
// agent 域载荷统一不含路由键（agent 名 / tool 名）——`:<agentName>` / `:<toolName>`
// 专属名订阅承载实体路由（名字在事件名里），通用名订阅是实体无关的横切处理；
// 载荷再带实体名与专属事件名冗余，两条等价分流路径并存造成使用困惑（口径见
// appEventBus.md「通用名与专属名的分工」）。

/** `agent:before-tool-call` 载荷——tool/sub-agent 执行前守卫 */
export interface BeforeToolCallEvent {
  /** LLM 传入的入参——handler 可整体替换（`payload.args = {...}`） */
  args: Record<string, unknown>;
  ctx: AgentToolContext;
  /** handler 设置即拒绝执行（扇出后统一判定,`{ error }` 回传 LLM）；不设 = 放行 */
  error?: string;
}

/** `agent:after-tool-call` 载荷——成功执行后审计（观察面） */
export interface AfterToolCallEvent {
  args: Record<string, unknown>;
  /** 成功结果（改写不回写执行链路——观察类事件） */
  result: unknown;
  ctx: AgentToolContext;
}

/** `agent:filter-tools` 载荷——LLM 可见 tools 清单过滤 */
export interface FilterToolsEvent {
  /** handler 原地 filter/splice（含 agent-as-tool 派发项） */
  tools: LLMToolDefinition[];
  ctx: AgentToolContext;
}

/** `agent:system-prompt` 载荷——systemPrompt 装饰 */
export interface SystemPromptEvent {
  /** vars 渲染后的 base——handler 改写即最终 system 消息 */
  prompt: string;
  ctx: AgentToolContext;
}

/** `agent:sub-agent-context` 载荷——派发边界供数 */
export interface SubAgentContextEvent {
  /** 校验后的派发入参 */
  args: Record<string, unknown>;
  /** handler 设置 → 追加进子代理 system（\n\n 拼接；不设/空串跳过；多 handler 后设覆盖） */
  context?: string;
  ctx: AgentToolContext;
}

// ─── 应用与任务域载荷 ──────────────────────────────

/** `request:error` 载荷——服务端故障（5xx）错误响应发出后的观察面；已处理 4xx 不发射（观察走请求日志 warn） */
export interface RequestErrorEvent {
  error: unknown;
  /** 请求上下文（仅 5xx 发射；请求准备阶段错误无 ctx → 整个事件不发射） */
  ctx: FaapiContext;
}

// `app:boot` / `app:ready` / `app:close` 载荷复用 `LifecycleContext`
// （rootDir/routes/server/registries/tasks/config 活引用）；
// `task:failed` 载荷复用 `TaskFailedInfo`。

// ─── 事件名常量与 helper ──────────────────────────────

/** 框架事件名常量（通用名;专属名经 helper 拼接,类型收窄到目录内模板） */
export const APP_EVENT = {
  agentRootInput: 'agent:root-input',
  agentInput: 'agent:input',
  agentHistoryOverBudget: 'agent:history-over-budget',
  agentBeforeToolCall: 'agent:before-tool-call',
  agentAfterToolCall: 'agent:after-tool-call',
  agentFilterTools: 'agent:filter-tools',
  agentSystemPrompt: 'agent:system-prompt',
  agentSubAgentContext: 'agent:sub-agent-context',
  appBoot: 'app:boot',
  appReady: 'app:ready',
  appClose: 'app:close',
  requestError: 'request:error',
  taskFailed: 'task:failed',
} as const;

/** 指定 agent 的 `agent:root-input` 专属事件名 */
export function agentRootInputEventName(agentName: string): `agent:root-input:${string}` {
  return `agent:root-input:${agentName}`;
}

/** 指定 agent 的 `agent:input` 专属事件名 */
export function agentInputEventName(agentName: string): `agent:input:${string}` {
  return `agent:input:${agentName}`;
}

/** 指定 agent 的 `agent:history-over-budget` 专属事件名 */
export function agentHistoryOverBudgetEventName(
  agentName: string,
): `agent:history-over-budget:${string}` {
  return `agent:history-over-budget:${agentName}`;
}

/** 指定 tool/派发名的 `agent:before-tool-call` 专属事件名 */
export function agentBeforeToolCallEventName(name: string): `agent:before-tool-call:${string}` {
  return `agent:before-tool-call:${name}`;
}

/** 指定 tool/派发名的 `agent:after-tool-call` 专属事件名 */
export function agentAfterToolCallEventName(name: string): `agent:after-tool-call:${string}` {
  return `agent:after-tool-call:${name}`;
}

/** 指定 agent 的 `agent:filter-tools` 专属事件名 */
export function agentFilterToolsEventName(agentName: string): `agent:filter-tools:${string}` {
  return `agent:filter-tools:${agentName}`;
}

/** 指定 agent 的 `agent:system-prompt` 专属事件名 */
export function agentSystemPromptEventName(agentName: string): `agent:system-prompt:${string}` {
  return `agent:system-prompt:${agentName}`;
}

/** 指定 agent 的 `agent:sub-agent-context` 专属事件名 */
export function agentSubAgentContextEventName(
  subName: string,
): `agent:sub-agent-context:${string}` {
  return `agent:sub-agent-context:${subName}`;
}

// ─── 总线 ────────────────────────────────────────────

export interface AppEventBus {
  /** 订阅事件,返回退订函数（幂等） */
  on<K extends FaapiAppEventName>(name: K, handler: AppEventHandler<K>): () => void;
  /**
   * 发射事件：按注册顺序 await 依次扇出,handler 抛错立即传播（剩余 handler 跳过,
   * fail fast）;返回最终载荷（handler 原地改写串联的结果）。无订阅者为 no-op。
   */
  emit<K extends FaapiAppEventName>(
    name: K,
    payload: FaapiAppEventMap[K],
  ): Promise<FaapiAppEventMap[K]>;
  /** 清空全部订阅（app.close() 时调用——app 实例级生命周期） */
  clear(): void;
}

/**
 * 创建 app 实例级事件总线
 *
 * 内部存储用 `never` 参数的逆变安全形态（任何具体载荷 handler 都可赋值）,
 * 发射点还原为精确签名——公开 API 保持全类型,内部无 unknown。
 */
export function createAppEventBus(): AppEventBus {
  type AnyHandler = (payload: never) => void | Promise<void>;
  const handlers = new Map<string, Set<AnyHandler>>();

  return {
    on(name, handler) {
      let set = handlers.get(name);
      if (!set) {
        set = new Set();
        handlers.set(name, set);
      }
      set.add(handler);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        set.delete(handler);
      };
    },

    async emit(name, payload) {
      const set = handlers.get(name);
      if (!set || set.size === 0) return payload;
      // 快照扇出：扇出中途退订不影响在途分发（快照语义,见 appEventBus.md）
      for (const handler of [...set]) {
        await (handler as AppEventHandler<typeof name>)(payload);
      }
      return payload;
    },

    clear() {
      handlers.clear();
    },
  };
}
