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

/** `agent:root-input` 载荷——本次对话的首条 user 消息（handler 可原地改写 input） */
export interface AgentRootInputEvent {
  /** 本次对话的 agent 名（子代理派发时为子代理名） */
  agentName: string;
  /** 本次对话首条 user 输入（根调用为 run/stream 入参;子代理为派发入参提取产物） */
  input: string;
  /** 请求上下文（HTTP 路径为请求收窄 ctx;任务路径为任务合成 ctx） */
  ctx: AgentToolContext;
}

/** `agent:input` 载荷——本轮将发送给 LLM 的消息副本（handler 可原地改写 messages） */
export interface AgentInputEvent {
  /** 当前循环的 agent 名 */
  agentName: string;
  /** 递归深度（根循环 = 1） */
  depth: number;
  /** 本轮发送副本（历史裁剪/压缩后）——改写仅作用本轮发送,不落历史 */
  messages: LLMMessage[];
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

// ─── agent 工具链 / systemPrompt / 派发上下文载荷（原 authHooks 等钩子迁移）──

/** `agent:before-tool-call` 载荷——tool/sub-agent 执行前守卫（原 beforeToolCall 钩子） */
export interface BeforeToolCallEvent {
  /** tool 名或派发名 `agent-<name>`（与原 beforeToolCall 钩子同语义） */
  name: string;
  /** LLM 传入的入参——handler 可整体替换（`payload.args = {...}`） */
  args: Record<string, unknown>;
  ctx: AgentToolContext;
  /** handler 设置即拒绝执行（扇出后统一判定,`{ error }` 回传 LLM）；不设 = 放行 */
  error?: string;
}

/** `agent:after-tool-call` 载荷——成功执行后审计（原 afterToolCall 钩子,观察面） */
export interface AfterToolCallEvent {
  name: string;
  args: Record<string, unknown>;
  /** 成功结果（改写不回写执行链路——观察类事件） */
  result: unknown;
  ctx: AgentToolContext;
}

/** `agent:filter-tools` 载荷——LLM 可见 tools 清单过滤（原 filterTools 钩子） */
export interface FilterToolsEvent {
  /** 本次 run/stream 的 agent 名 */
  agentName: string;
  /** handler 原地 filter/splice（含 agent-as-tool 派发项） */
  tools: LLMToolDefinition[];
  ctx: AgentToolContext;
}

/** `agent:system-prompt` 载荷——systemPrompt 装饰（原 resolveSystemPrompt 钩子） */
export interface SystemPromptEvent {
  agentName: string;
  /** vars 渲染后的 base——handler 改写即最终 system 消息 */
  prompt: string;
  ctx: AgentToolContext;
}

/** `agent:sub-agent-context` 载荷——派发边界供数（原 resolveSubAgentContext 钩子） */
export interface SubAgentContextEvent {
  /** 真实 agent 名（非派发名） */
  subName: string;
  /** 校验后的派发入参 */
  args: Record<string, unknown>;
  /** handler 设置 → 追加进子代理 system（\n\n 拼接；不设/空串跳过；多 handler 后设覆盖） */
  context?: string;
  ctx: AgentToolContext;
}

// ─── 应用与任务域载荷 ──────────────────────────────

/** `request:error` 载荷——错误响应发出后的观察面（原 lifecycle.onError 钩子） */
export interface RequestErrorEvent {
  error: unknown;
  /** 请求上下文（请求准备阶段错误无 ctx → 整个事件不发射,对齐原钩子语义） */
  ctx: FaapiContext;
}

// `app:boot` / `app:ready` / `app:close` 载荷复用 `LifecycleContext`
// （原 lifecycle 钩子 ctx 类型,rootDir/routes/server/registries/tasks/config 活引用）；
// `task:failed` 载荷复用 `TaskFailedInfo`。

// ─── 事件名常量与 helper ──────────────────────────────

/** 框架事件名常量（通用名;专属名经 helper 拼接,类型收窄到目录内模板） */
export const APP_EVENT = {
  agentRootInput: 'agent:root-input',
  agentInput: 'agent:input',
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
