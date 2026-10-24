import type { Logger } from '../loggers/loggerTypes';
import type { FaapiContext } from './contextTypes';

/**
 * tool handler ctx 的框架注入字段载体——tasks/log/signal 三字段在三条约 agent
 * 执行路径上（HTTP / 进程内任务 / 隔离任务）由框架保证恒在恒正确。
 *
 * **刻意声明为 type alias（非 interface）**：拒绝 `declare module` 增强——业务侧
 * 增强声明会因同名重复标识符编译报错（TS2300）。理由：增强是交叉标注之外的
 * 第二条业务字段通道，语义分裂（增强侧可选不校验、校验类型侧必填校验）且
 * 「类型在、运行时路径依赖在场」的中间态靠消费方自觉兜底，与 fail-fast 哲学
 * 不符；业务字段唯一通道是**交叉标注业务校验类型**（可选字段用 `?:` 表达，
 * 构建期生成 schema 运行时声明即校验）：
 *
 * ```ts
 * interface OrderCtx {
 *   currentUserId: number;   // 业务校验字段——运行时校验保证在场
 *   chatNovelId?: number;    // 路径依赖可选字段——缺席通过校验，读取点自断言
 * }
 * export function getOrder(input: Input, ctx: OrderCtx & AgentToolContext) {
 *   ctx.currentUserId;   // 校验保证
 *   ctx.log.info('...'); // 框架字段类型在
 * }
 * ```
 *
 * 注意：**不要 extends 本类型**声明业务校验类型——tasks 的 `import('...').TaskClient`
 * 类型语法构建期提取即抛 SchemaExtractionError；交叉标注是唯一的框架字段携带
 * 形态。第二参裸标注本类型（只要框架字段不要业务校验）合法——不生成 schema
 * 不校验。
 *
 * 三路径填充规则与排除清单见 [agentToolContext.md](./agentToolContext.md)。
 */
export type AgentToolContext = {
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
};

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
