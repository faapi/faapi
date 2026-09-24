/**
 * 客户端统一错误类型与响应信封类型。
 *
 * 零依赖约束:本模块属于浏览器端代码(@faapi/next/client 子路径),禁止
 * import @faapi/faapi 及任何 Node 模块——主包含 fs/child_process 等服务端
 * 依赖,传递性引入会把服务端代码拉进浏览器 bundle,导致 Next.js 客户端
 * 打包失败。类型独立声明、结构镜像主包,详见 apiError.md。
 */

/**
 * 字段级校验详情,镜像主包 ValidationIssue(path/code/expected/received/message)。
 *
 * 服务端 JSON 的形状即客户端类型;主包结构变更时此处需手动同步。
 */
export interface ApiValidationIssue {
  /** 字段路径,如 'user.address.city' */
  path: string;
  /** 错误码,机器可读的契约,如 'TYPE_MISMATCH' */
  code: string;
  /** 期望类型/值,如 'number' */
  expected: string;
  /** 实际类型/值,如 'string' */
  received: string;
  /** 人类可读的字段级错误描述 */
  message: string;
}

/** 失败信封:{ error: { message, ...code?, ...issues? } }(主包 defaultFail 中 code 省略时不存在) */
export interface ApiErrorBody {
  error: {
    code?: string;
    message: string;
    issues?: ApiValidationIssue[];
  };
}

/**
 * faapi 默认响应信封:成功 { data } / 失败 { error }。
 * 与主包 config.response.ok/fail 的默认实现一致;业务方自定义信封时
 * 不适用(见 apiCall.md 已知限制)。
 */
export type ApiEnvelope<T> = Partial<{ data: T }> & Partial<ApiErrorBody>;

/**
 * API 错误:携带 code/status/issues,调用方可按 code 分支处理。
 *
 * 继承 Error,现有 `e instanceof Error ? e.message : String(e)` 的
 * toast 消费代码不受影响。
 */
export class ApiError extends Error {
  /** 字符串业务错误码,如 'VALIDATION_ERROR';非信封错误为框架侧兜底码 */
  readonly code: string;
  /** HTTP 状态码 */
  readonly status: number;
  /** VALIDATION_ERROR 时的字段级校验详情,供表单回显 */
  readonly issues?: readonly ApiValidationIssue[];

  constructor(
    code: string,
    status: number,
    message: string,
    issues?: readonly ApiValidationIssue[],
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.issues = issues;
  }
}
