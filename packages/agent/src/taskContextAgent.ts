/**
 * TaskContext.agent 类型增强（declare module 声明合并）
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
 * 隔离任务（worker.ts 声明）同样有 `taskCtx.agent`：run 消息携带 `agentChannel:
 * true`（宿主 agentToolRunner 已注册）时，worker 内动态加载 `@faapi/agent` 组装
 * 带 RPC 垫片的 Agent——编排循环在 worker，工具/钩子回传宿主执行（见
 * faapi 的 workerEntry.ts buildAgentChannel 与 taskTypes.md）；宿主 agentToolRunner
 * 未注册（插件未加载）时隔离任务恒 undefined——能力不存在非降级。
 */

import type { TaskContext } from '@faapi/faapi';
import type { AgentHandle } from './agentHandle';

declare module '@faapi/faapi' {
  interface TaskContext {
    /**
     * 静默组装的 Agent（惰性，仅进程内任务）：首次访问经 agentHandle 工厂以
     * `taskCtx.carry` 为执行 ctx 构造并缓存复用；插件未注册工厂或隔离任务为
     * `undefined`。使用前建议判空（fail fast）
     */
    agent?: AgentHandle;
  }
}

// 类型级声明合并的落地锚点（确保本模块被 import 时增强生效；无运行时导出）
export type { TaskContext as TaskContextWithAgent };
