import { FaapiError } from './FaapiError';

/**
 * 根据 issues 中的 code 推导 HTTP 状态码
 *
 * 语义参考 RFC 7807 / Rails / Laravel / Spring：
 * - 400 Bad Request：请求语法错误或结构不完整
 *   - INVALID_FORMAT：JSON 格式错误、Date 非 ISO 8601
 *   - MISSING_FIELD：缺少必填字段
 * - 422 Unprocessable Entity：请求语法正确但语义错误
 *   - TYPE_MISMATCH：类型不匹配（string 期望 number）
 *   - INVALID_VALUE：值不在允许范围（字面量/enum 不匹配）
 *   - COERCE_FAILED：query 字符串转换失败
 *
 * 多个 issue 时取最高严重度（400 优先于 422）。
 */
function deriveStatusCode(issues: ValidationIssue[]): number {
  // 有 400 类 issue → 400；否则 422
  const has400 = issues.some((i) => i.code === 'INVALID_FORMAT' || i.code === 'MISSING_FIELD');
  return has400 ? 400 : 422;
}

export class ValidationError extends FaapiError {
  constructor(
    message: string,
    public readonly issues: ValidationIssue[],
  ) {
    super('VALIDATION_ERROR', message, deriveStatusCode(issues));
    this.name = 'ValidationError';
  }
}

export class RouteNotFoundError extends FaapiError {
  constructor(path: string) {
    super('ROUTE_NOT_FOUND', `Route not found: ${path}`, 404);
    this.name = 'RouteNotFoundError';
  }
}

export class MethodNotAllowedError extends FaapiError {
  constructor(
    method: string,
    path: string,
    public readonly allowedMethods: string[],
  ) {
    super('METHOD_NOT_ALLOWED', `Method ${method} not allowed for ${path}`, 405);
    this.name = 'MethodNotAllowedError';
  }
}

export class InternalError extends FaapiError {
  constructor(message: string) {
    super('INTERNAL_ERROR', message, 500);
    this.name = 'InternalError';
  }
}

export class ModuleLoadError extends FaapiError {
  constructor(filePath: string, reason: string) {
    super('MODULE_LOAD_ERROR', `Failed to load module ${filePath}: ${reason}`, 500);
    this.name = 'ModuleLoadError';
  }
}

/**
 * 校验问题类型
 *
 * 结构化错误信息,便于上层(全局错误中间件/前端)按 code 做不同处理,
 * 不依赖字符串解析。message 仅为人类可读的兜底描述。
 *
 * code 与 HTTP 状态码的映射（由 ValidationError 推导）：
 * - INVALID_FORMAT / MISSING_FIELD → 400 Bad Request
 * - TYPE_MISMATCH / INVALID_VALUE / COERCE_FAILED → 422 Unprocessable Entity
 */
export interface ValidationIssue {
  /** 字段路径,如 'user.address.city' */
  path: string;
  /** 错误码,机器可读的契约 */
  code: ValidationErrorCode;
  /** 期望类型/值,如 'number' / '"admin" | "user"' */
  expected: string;
  /** 实际类型/值,如 'string' / 'undefined' */
  received: string;
  /** 人类可读的本地化消息(兜底,不保证稳定) */
  message: string;
}

export type ValidationErrorCode =
  | 'TYPE_MISMATCH' // 类型不匹配(string 期望 number) → 422
  | 'MISSING_FIELD' // 缺少必填字段 → 400
  | 'INVALID_FORMAT' // 格式错误(JSON 解析失败、Date 非 ISO 等) → 400
  | 'INVALID_VALUE' // 值不在允许范围(字面量/enum 不匹配) → 422
  | 'COERCE_FAILED'; // 类型转换失败(query 字符串转 number/boolean 失败) → 422
