/**
 * agent 提醒注入引擎
 *
 * 在 agent 对话的 user 消息上注入 `<system-reminder>` 包裹的上下文提醒：
 * - **once（首轮持久）**：fresh run 时渲染一次，追加到初始 user 消息并持久进循环历史
 * - **everyTurn（每轮刷新）**：每轮 LLM 请求前渲染，追加到发送副本末条 user 消息（本地历史不变）
 *
 * 语义规格见 [reminders.md](./reminders.md)。类型（ReminderInfo / ReminderPhase）
 * 定义在主包 `configs/configTypes.ts`，此处 re-export 供消费方统一导入。
 *
 * reactLoop 只消费 ReminderResolver（保持循环层纯消息管线）；供数收敛为
 * `resolveReminders` deps 级钩子唯一入口（业务 decorateDeps 接线 / 隔离任务
 * RPC 垫片同走此路）——spec 声明面已整体移除（8.0，迁移守卫为 config 白名单报错）。
 */
import type { AgentToolContext, ReminderInfo, ReminderPhase } from '@faapi/faapi';
import { AgentError } from './agentErrors';

export type { ReminderInfo, ReminderPhase } from '@faapi/faapi';

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

/** 内容串数组 → 完整包裹块（每条各自 `<system-reminder>` 包裹，`\n\n` 连接）；空数组 undefined */
export function joinReminderBlocks(contents: readonly string[]): string | undefined {
  if (contents.length === 0) return undefined;
  return contents.map((c) => `<system-reminder>\n${c}\n</system-reminder>`).join('\n\n');
}

/**
 * 钩子解析器（AgentDeps.resolveReminders 接线时使用——唯一供数入口）
 *
 * 运行时防护与原 spec 路径拉齐：钩子抛错包 `AgentError`（含 agent 名与 phase，
 * `{ cause }` 保留原始错误）；返回值非 `string[]`（非数组或数组含非 string 元素）
 * 抛 `AgentError`（返回类型违约，fail fast——静默渲染会让坏数据伪装成提醒内容）。
 */
export function createHookReminderResolver(
  hook: ResolveRemindersHook,
  base: { agentName: string; depth: number; ctx: AgentToolContext },
): ReminderResolver {
  const resolve = async (phase: ReminderPhase, turn: number): Promise<string | undefined> => {
    let contents: string[] | undefined;
    try {
      contents = await hook({ ...base, turn, phase });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const wrapped = new AgentError(
        `resolveReminders hook failed (agent "${base.agentName}", phase=${phase}): ${message}`,
      );
      wrapped.cause = err;
      throw wrapped;
    }
    if (contents !== undefined && (!Array.isArray(contents) || !isStringArray(contents))) {
      throw new AgentError(
        `resolveReminders must return string[] | undefined (agent "${base.agentName}", phase=${phase}) — got ${describeReturnValue(contents)}`,
      );
    }
    return joinReminderBlocks(contents ?? []);
  };
  return {
    once: () => resolve('once', 0),
    everyTurn: (turn) => resolve('everyTurn', turn),
  };
}

function isStringArray(v: readonly unknown[]): v is string[] {
  return v.every((c) => typeof c === 'string');
}

function describeReturnValue(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) {
    const nonString = v.findIndex((c) => typeof c !== 'string');
    return `array with non-string element at index ${nonString} (${typeof v[nonString]})`;
  }
  return typeof v;
}
