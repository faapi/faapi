/**
 * TaskContext.agent / IsolatedTaskContext.agent 类型增强（declare module 声明合并）
 *
 * 任务子系统的 `taskCtx.agent` 惰性通道（faapi 7.1 起）：进程内任务首次访问时
 * 经 agentHandle 工厂以 `taskCtx.carry`（enqueue 时 `opts.carry` 声明的执行
 * 上下文快照）为执行 ctx 构造——与 HTTP 请求链的 `agent` 参数注入同一份
 * baseDeps（插件 setup 闭包），authHooks/tool handler 第二参数读到 carry 内的
 * 身份与标记字段（如 `currentUserId`）。
 *
 * 主包 `TaskContext` 不声明该字段（主包不反向依赖本包的类型）：运行时由语义层
 * 以 getter 挂载，类型由本声明合并提供——业务 import `@faapi/agent` 即得强
 * 类型；未安装本包的项目类型与运行时行为一致（字段不存在）。
 *
 * 隔离任务（worker.ts 声明）的 `taskCtx.agent` 是 **run-only RPC 句柄**
 * （{@link AgentRpcHandle}）：`run` 经单次 agent-run 消息回传宿主，宿主构造
 * Agent 跑完整编排循环（LLM IO、tool 执行、钩子、reminders、sub-agent 全在
 * 宿主，见 faapi 的 workerEntry.ts buildAgentRunProxy 与 taskTypes.md）；流式
 * 不支持。宿主 agentRunner 未注册（插件未加载）时隔离任务恒 undefined——能力
 * 不存在非降级。调用形态与进程内一致：`taskCtx.agent.run(input, { agent })`。
 */

import type { TaskContext, IsolatedTaskContext } from '@faapi/faapi';
import type { AgentHandle, AgentRunOptions } from './agentHandle';
import type { ReactLoopResult } from './reactLoop';

/**
 * 隔离任务 `taskCtx.agent` 的 run-only 句柄（RPC 形态）
 *
 * `run` 签名与 {@link AgentHandle.run} 完全一致（业务代码零改动跨路径），差异：
 * - 经单次 agent-run RPC 在宿主执行完整循环（编排收敛宿主）
 * - 流式（stream）与 asTool 不可用——句柄无此成员
 * - `options.provider` 仅支持 LlmConfig 纯数据（LLMProvider 实例不可跨线程，
 *   worker 侧代理显式报错指引）
 */
export interface AgentRpcHandle {
  /** 非流式执行 agent（完整语义见 AgentHandle.run） */
  run(input?: string, options?: AgentRunOptions): Promise<ReactLoopResult>;
}

declare module '@faapi/faapi' {
  interface TaskContext {
    /**
     * 静默组装的 Agent（惰性，仅进程内任务）：首次访问经 agentHandle 工厂以
     * `taskCtx.carry` 为执行 ctx 构造并缓存复用；插件未注册工厂或隔离任务为
     * `undefined`。使用前建议判空（fail fast）
     */
    agent?: AgentHandle;
  }
  interface IsolatedTaskContext {
    /**
     * agent-run RPC 句柄（run-only，仅隔离任务）：`run` 经单次消息回传宿主跑
     * 完整循环；插件未注册 agentRunner（或隔离 worker 消息未带 agentChannel）
     * 时为 `undefined`。使用前建议判空（fail fast）
     */
    agent?: AgentRpcHandle;
  }
}

// 类型级声明合并的落地锚点（确保本模块被 import 时增强生效；无运行时导出）
export type {
  TaskContext as TaskContextWithAgent,
  IsolatedTaskContext as IsolatedTaskContextWithAgent,
};
