import type { ResponseConfig } from '../config/configTypes';
import { FaapiError } from '../errors/FaapiError';
import { ValidationError, MethodNotAllowedError, PayloadTooLargeError } from '../errors/httpErrors';

/**
 * 统一响应格式化中心
 *
 * 集中所有响应包装规则,确保 handler return 值的自动包裹、ctx.fail() 主动错误响应、
 * formatErrorResponse 抛错兜底 三条路径共享同一套 ok/fail 函数,避免响应格式漂移。
 *
 * 路径分工:
 * - 成功路径: handler `return data` → wrapOkResult → toResponse 多类型序列化
 * - 显式成功: handler `return ctx.ok(data)` → wrapOkResult → jsonOk 构造 Response
 * - 主动错误: handler `return ctx.fail({...})` → formatFailResponse → jsonOk
 * - 抛错兜底: handler throw → formatErrorResponse(err, config) → jsonOk
 *
 * 业务方通过 faapi.config.ts 的 `response.ok` / `response.fail` 自定义包装函数,
 * 三条路径自动一致生效。
 */

/** 默认 ok 包装：(data) => ({ data }) */
export function defaultOk(data: unknown): Record<string, unknown> {
  return { data };
}

/**
 * 默认 fail 包装:省略的字段不放入 error 对象
 *
 * `code` 为 undefined 时不放入响应,保持 body 紧凑。
 */
export function defaultFail(e: {
  status?: number;
  code?: string;
  message: string;
}): Record<string, unknown> {
  const error: Record<string, unknown> = { message: e.message };
  if (e.code !== undefined) error.code = e.code;
  return { error };
}

/** 从 ctx.config 读取 ResponseConfig（业务方在 faapi.config.ts 中配置的 response 字段） */
export function getResponseConfig(
  config: Record<string, unknown> | undefined,
): ResponseConfig | undefined {
  return (config as { response?: ResponseConfig } | undefined)?.response;
}

/** 解析 ok 函数:业务方自定义 ?? 框架默认 */
export function resolveOkFn(config: Record<string, unknown> | undefined) {
  return getResponseConfig(config)?.ok ?? defaultOk;
}

/** 解析 fail 函数:业务方自定义 ?? 框架默认 */
export function resolveFailFn(config: Record<string, unknown> | undefined) {
  return getResponseConfig(config)?.fail ?? defaultFail;
}

/**
 * 构造 JSON 成功响应（不包裹,原样序列化）
 *
 * 用于 ctx.json / ctx.ok 等显式响应场景。
 */
export function jsonOk(body: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  return jsonRaw(body, status, extraHeaders);
}

/** 内部:构造 JSON Response,不包外层 */
function jsonRaw(body: unknown, status: number, extraHeaders?: HeadersInit): Response {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (extraHeaders) {
    const extra = new Headers(extraHeaders);
    extra.forEach((value, key) => headers.set(key, value));
  }
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * 成功响应自动包装:handler return 值 → okFn(data) 包裹
 *
 * 规则:
 * - Response 对象:不包裹(ctx.ok/ctx.fail/ctx.json 等返回的 Response 原样透传)
 * - 其他值(含 null/undefined):用 config.response.ok(或默认 (data) => ({ data })) 包裹
 *
 * 注:null/undefined 也会被包裹为 { data: null } / { data: undefined }。
 *
 * 不构造 Response,只返回包装后的值——最终序列化交给 toResponse 处理(支持多类型分发 +
 * 合并 ctx.meta 的 setStatus/setHeader/setCookie)。
 */
export function wrapOkResult(
  result: unknown,
  config: Record<string, unknown> | undefined,
): unknown {
  if (result instanceof Response) return result;
  return resolveOkFn(config)(result);
}

/**
 * 业务方主动错误响应:FailOptions → Response
 *
 * handler `return ctx.fail({ status, code, message })` 的实现。
 * 用 config.response.fail(或默认实现)包装为 `{ error: { ... } }` 结构。
 *
 * `status` 省略时默认 500;`code` 省略时由 fail 函数决定是否放入 body。
 */
export function formatFailResponse(
  options: { status?: number; code?: string; message: string },
  config: Record<string, unknown> | undefined,
): Response {
  const failFn = resolveFailFn(config);
  const body = failFn({
    status: options.status,
    code: options.code,
    message: options.message,
  });
  return jsonOk(body, options.status ?? 500);
}

/**
 * 抛错兜底响应:把 handler 抛出的错误转换为统一格式的 Response
 *
 * 覆盖的 FaapiError 子类:
 * - ValidationError → 400/422 + issues
 * - MethodNotAllowedError → 405 + Allow header
 * - PayloadTooLargeError → 413
 * - 其他 FaapiError 子类 → 用 error.statusCode
 * - 未知 Error / 非 Error → 500 INTERNAL_ERROR
 *
 * 与 [formatFailResponse] 共享同一套 fail 函数:业务方在 faapi.config.ts 自定义的
 * `response.fail` 会同时应用到「主动错误响应」和「抛错兜底响应」,确保错误格式一致。
 *
 * @param error handler 抛出的错误
 * @param config 业务方配置(用于读取 response.fail 自定义包装函数,可选)
 */
export function formatErrorResponse(
  error: unknown,
  config?: Record<string, unknown> | undefined,
): Response {
  const failFn = resolveFailFn(config);

  if (error instanceof ValidationError) {
    const body = failFn({
      status: error.statusCode,
      code: error.code,
      message: error.message,
    });
    // ValidationError 需要附加 issues 字段,在 fail body 上扩展
    const bodyObj =
      typeof body === 'object' && body !== null
        ? (body as Record<string, unknown>)
        : { error: body };
    const errorObj =
      (bodyObj.error as Record<string, unknown> | undefined) ??
      (bodyObj as Record<string, unknown>);
    if (errorObj) {
      errorObj.issues = error.issues;
    }
    return jsonOk(bodyObj, error.statusCode);
  }

  if (error instanceof MethodNotAllowedError) {
    const body = failFn({
      status: error.statusCode,
      code: error.code,
      message: error.message,
    });
    return jsonOk(body, error.statusCode, { Allow: error.allowedMethods.join(', ') });
  }

  if (error instanceof PayloadTooLargeError) {
    const body = failFn({
      status: error.statusCode,
      code: error.code,
      message: error.message,
    });
    return jsonOk(body, error.statusCode);
  }

  if (error instanceof FaapiError) {
    const body = failFn({
      status: error.statusCode,
      code: error.code,
      message: error.message,
    });
    return jsonOk(body, error.statusCode);
  }

  // 未知错误:500 INTERNAL_ERROR
  const message = error instanceof Error ? error.message : 'An unknown error occurred';
  const body = failFn({ status: 500, code: 'INTERNAL_ERROR', message });
  return jsonOk(body, 500);
}
