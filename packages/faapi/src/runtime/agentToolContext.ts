import type { Logger } from '../loggers/loggerTypes';
import type { FaapiContext } from './contextTypes';

/**
 * tool handler 第二参数的框架契约——必有，基础字段在三条约 agent 执行路径上
 * （HTTP / 进程内任务 / 隔离任务）由框架保证正确。
 *
 * 与历史契约（`Partial<FaapiContext> | undefined`）的差异：ctx 对象恒有、
 * 下列字段恒正确，工具不再面对"路径决定完整性"的彩票。业务身份字段
 * （currentUserId 等）不在框架保证范围内——经 `declare module '@faapi/faapi'`
 * 增强本接口（与 FaapiContext 同款模式）：
 *
 * ```ts
 * declare module '@faapi/faapi' {
 *   interface AgentToolContext {
 *     currentUserId?: number;
 *   }
 * }
 * ```
 *
 * 增强字段的在场性由各路径的填充规则决定（HTTP 由业务中间件塞入、任务随
 * carry 声明、测试直调显式构造），缺失时业务侧以 fail-closed 断言消费
 * （如 requireUserId）——cron/系统触发没有用户身份是语义，不是缺陷。
 *
 * 三路径填充规则与排除清单见 [agentToolContext.md](./agentToolContext.md)。
 */
export interface AgentToolContext {
  /**
   * 任务队列客户端——HTTP: app 实例（registries.taskHandle 注入）；任务:
   * 同一 app 实例的 scoped TaskClient；隔离任务: 工具在宿主执行，收到宿主侧
   * scoped TaskClient（参数与返回值受结构化克隆约束）；无队列编排的 ctx
   * （轻量测试设施/编程式裸构）为抛错桩——调用即显式失败并给修复指引
   */
  tasks: import('../tasks/taskTypes.js').TaskClient;
  /**
   * 日志器——HTTP: 请求级（scope `http`，requestId/method/path）；任务: 任务级
   * （scope `task:<name>`，jobId/task/attempt）；隔离任务: 宿主侧任务级 logger
   */
  log: Logger;
  /**
   * 取消信号——HTTP: `request.signal`（客户端断开）；任务: `job.signal`
   * （停机/超时两段式取消的第一段 abort）。长耗时上游调用可携带：
   * `fetch(url, { signal: ctx.signal })`
   */
  signal: AbortSignal;
}

/** tasks 抛错桩的统一消息（调用即失败，指引接真实链路或注入假体） */
function taskStubMessage(): string {
  return (
    '当前 ctx 无任务队列（无 app 编排的请求链路——轻量测试设施/编程式构造）。' +
    '需要任务交互时：走真实 app 编排（createAppBase/createTestServer 接队列），' +
    '或测试场景注入自有 TaskClient 假体'
  );
}

/**
 * 任意方法调用即抛错的 TaskClient 桩
 *
 * 无队列编排场景下 AgentToolContext.tasks 的诚实缺省——字段恒在（契约必有），
 * 用即显式失败（禁止降级：不静默假成功、不返回 undefined）。`@faapi/agent`
 * 的 createStandaloneToolContext 复用同一实现（单一语义）。
 *
 * `then` 属性返回 undefined：桩可能被原样透传（handler `return ctx.tasks` 后
 * 经 await 链路），thenable 检查不得误触——否则 await 一个透传值会炸出桩错误，
 * 掩盖真实的调用点。
 */
export function createThrowingTaskClient(): AgentToolContext['tasks'] {
  const throwFn = () => {
    throw new Error(taskStubMessage());
  };
  return new Proxy({} as AgentToolContext['tasks'], {
    get(_target, prop) {
      if (prop === 'then') return undefined;
      return throwFn;
    },
  }) as AgentToolContext['tasks'];
}

/**
 * 把完整请求 ctx 收窄为 tool 执行契约（HTTP 路径的 agentHandle 工厂入参）
 *
 * `FaapiContext` 是契约的超集：log/signal 恒有，tasks 由 registries.taskHandle
 * 注入——真实 app 编排恒有；无队列编排的 ctx（轻量测试设施/编程式裸构）填充
 * 抛错桩（字段恒在、调用即显式失败）。ctx 上的业务增强字段随展开原样透传
 * （顶层可读）。
 */
export function toAgentToolContext(ctx: FaapiContext): AgentToolContext {
  // 展开透传 ctx 全量字段（含业务增强），tasks 以非空值覆盖——契约字段后置，
  // 调用方后续字段不可覆盖框架保证
  return { ...ctx, tasks: ctx.tasks ?? createThrowingTaskClient() };
}
