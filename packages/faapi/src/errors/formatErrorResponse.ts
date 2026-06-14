import { FaapiError } from './FaapiError';
import { ValidationError, MethodNotAllowedError } from './httpErrors';

/**
 * 将错误转换为统一的 JSON 响应结构
 *
 * 格式：
 * {
 *   "error": {
 *     "code": "VALIDATION_ERROR",
 *     "message": "Invalid query parameters",
 *     "issues": [...] // 仅 ValidationError 包含
 *   }
 * }
 */
export function formatErrorResponse(error: unknown): Response {
  if (error instanceof ValidationError) {
    const body: Record<string, unknown> = {
      code: error.code,
      message: error.message,
      issues: error.issues,
    };
    return new Response(JSON.stringify({ error: body }), {
      status: error.statusCode,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (error instanceof MethodNotAllowedError) {
    const body = {
      code: error.code,
      message: error.message,
    };
    return new Response(JSON.stringify({ error: body }), {
      status: error.statusCode,
      headers: {
        'Content-Type': 'application/json',
        Allow: error.allowedMethods.join(', '),
      },
    });
  }

  if (error instanceof FaapiError) {
    const body = {
      code: error.code,
      message: error.message,
    };
    return new Response(JSON.stringify({ error: body }), {
      status: error.statusCode,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // 未知错误：500 INTERNAL_ERROR
  const body = {
    code: 'INTERNAL_ERROR',
    message: error instanceof Error ? error.message : 'An unknown error occurred',
  };
  return new Response(JSON.stringify({ error: body }), {
    status: 500,
    headers: { 'Content-Type': 'application/json' },
  });
}
