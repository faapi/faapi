/**
 * agent 提醒注入引擎
 *
 * 在 agent 对话的 user 消息上注入 `<system-reminder>` 包裹的上下文提醒：
 * - **once（首轮持久）**：fresh run 时渲染一次，追加到初始 user 消息并持久进循环历史
 * - **everyTurn（每轮刷新）**：每轮 LLM 请求前渲染，追加到发送副本末条 user 消息（本地历史不变）
 *
 * 语义规格见 [reminders.md](./reminders.md)。类型（ReminderSpec 族）定义在主包
 * `configs/configTypes.ts`（与 AgentConfig 同侧），此处 re-export 供消费方统一导入。
 *
 * reactLoop 只消费 ReminderResolver（保持循环层纯消息管线）；本模块同时提供
 * 本地 specs 解析器与钩子解析器（隔离任务 RPC 垫片 / 业务 decorateDeps 接线）。
 */
import type {
  AgentToolContext,
  ReminderBuilder,
  ReminderInfo,
  ReminderPhase,
  ReminderSpec,
} from '@faapi/faapi';
import { AgentError } from './agentErrors';

export type { ReminderBuilder, ReminderInfo, ReminderPhase, ReminderSpec } from '@faapi/faapi';

/** reactLoop 消费的提醒解析器（once = 首轮持久块 / everyTurn = 每轮发送副本块） */
export interface ReminderResolver {
  /** fresh run 时调用一次；返回完整包裹块（undefined = 不注入） */
  once: () => Promise<string | undefined>;
  /** 每轮请求前调用（turn 为当轮序号，1 起）；返回完整包裹块（undefined = 不注入） */
  everyTurn: (turn: number) => Promise<string | undefined>;
}

/** AgentDeps 级提醒供数钩子（返回该 phase 的未包裹内容串数组；undefined = 无提醒） */
export type ResolveRemindersHook = (
  info: ReminderInfo & { phase: ReminderPhase },
) => Promise<string[] | undefined>;

/** 解析 spec 的生效通道：string → once、函数 → everyTurn、对象形式 when 显式覆盖 */
export function reminderPhaseOf(spec: ReminderSpec): ReminderPhase {
  if (typeof spec === 'string') return 'once';
  if (typeof spec === 'function') return 'everyTurn';
  if (typeof spec !== 'object' || spec === null || !('content' in spec)) {
    throw new AgentError(
      `invalid reminder spec: expected string, function, or { when?, content } object — got ${typeof spec}`,
    );
  }
  if (spec.when !== undefined && spec.when !== 'once' && spec.when !== 'everyTurn') {
    throw new AgentError(
      `invalid reminder spec: when must be "once" or "everyTurn" — got "${String(spec.when)}"`,
    );
  }
  if (spec.when) return spec.when;
  return typeof spec.content === 'function' ? 'everyTurn' : 'once';
}

/**
 * 渲染指定 phase 的 specs 为未包裹内容串数组
 *
 * - 未命中 phase 的声明跳过；builder 返回 undefined/null/trim 空串的条目跳过
 * - builder 抛错 / 返回类型违约 / spec 形态违约 → 包 AgentError（fail fast，含定位）
 */
export async function renderReminderSpecs(
  specs: readonly ReminderSpec[],
  info: ReminderInfo,
  phase: ReminderPhase,
): Promise<string[]> {
  const out: string[] = [];
  for (const [index, spec] of specs.entries()) {
    let content: string | ReminderBuilder;
    try {
      if (reminderPhaseOf(spec) !== phase) continue;
      content = typeof spec === 'object' ? spec.content : spec;
    } catch (err) {
      throw wrapReminderError(err, info.agentName, phase, index);
    }
    if (typeof content === 'function') {
      let rendered: string | null | undefined;
      try {
        rendered = await (content as ReminderBuilder)(info);
      } catch (err) {
        throw wrapReminderError(err, info.agentName, phase, index);
      }
      if (rendered === undefined || rendered === null) continue;
      if (typeof rendered !== 'string') {
        throw new AgentError(
          `reminder builder must return string | undefined | null (agent "${info.agentName}", phase=${phase}, spec index ${index})`,
        );
      }
      if (rendered.trim() === '') continue;
      out.push(rendered);
    } else {
      if (content.trim() === '') continue;
      out.push(content);
    }
  }
  return out;
}

function wrapReminderError(
  err: unknown,
  agentName: string,
  phase: ReminderPhase,
  index: number,
): AgentError {
  const message = err instanceof Error ? err.message : String(err);
  const wrapped = new AgentError(
    `reminder rendering failed (agent "${agentName}", phase=${phase}, spec index ${index}): ${message}`,
  );
  wrapped.cause = err;
  return wrapped;
}

/** 内容串数组 → 完整包裹块（每条各自 `<system-reminder>` 包裹，`\n\n` 连接）；空数组 undefined */
export function joinReminderBlocks(contents: readonly string[]): string | undefined {
  if (contents.length === 0) return undefined;
  return contents.map((c) => `<system-reminder>\n${c}\n</system-reminder>`).join('\n\n');
}

/** 合并全局与单 agent 声明（全局在前——agent 特定内容更靠近上下文末端；各自保持声明序） */
export function collectReminderSpecs(
  globalSpecs: readonly ReminderSpec[] | undefined,
  agentSpecs: readonly string[] | undefined,
): ReminderSpec[] {
  return [...(globalSpecs ?? []), ...(agentSpecs ?? [])];
}

/** 本地 specs 解析器（buildLoopConfig 无钩子接线时的默认实现） */
export function createSpecReminderResolver(
  specs: readonly ReminderSpec[],
  base: { agentName: string; depth: number; ctx: AgentToolContext },
): ReminderResolver {
  return {
    once: async () =>
      joinReminderBlocks(await renderReminderSpecs(specs, { ...base, turn: 0 }, 'once')),
    everyTurn: async (turn) =>
      joinReminderBlocks(await renderReminderSpecs(specs, { ...base, turn }, 'everyTurn')),
  };
}

/**
 * 钩子解析器（AgentDeps.resolveReminders 接线时使用）
 *
 * 钩子是唯一供数源（本地 specs 整体忽略，避免双渲染）；钩子抛错原样传播
 * （与 resolveSubAgentContext 等 deps 级钩子同款——worker RPC 路径的错误回传
 * 由 RPC 层统一处理）。
 */
export function createHookReminderResolver(
  hook: ResolveRemindersHook,
  base: { agentName: string; depth: number; ctx: AgentToolContext },
): ReminderResolver {
  return {
    once: async () => joinReminderBlocks((await hook({ ...base, turn: 0, phase: 'once' })) ?? []),
    everyTurn: async (turn) =>
      joinReminderBlocks((await hook({ ...base, turn, phase: 'everyTurn' })) ?? []),
  };
}
