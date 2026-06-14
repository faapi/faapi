/**
 * 根据 HTTP 方法判断主输入类型
 *
 * - GET / DELETE / HEAD：query（URL 查询参数）
 * - POST / PUT / PATCH：body（请求体）
 *
 * 注意：所有方法都可能同时有 query 和 body，
 * 这里返回的是"主输入"（用于校验和注入）。
 * DELETE 请求也支持 body（见 resolveInput.ts）。
 */
export function getInputTypeForMethod(method: string): 'query' | 'body' {
  const upper = method.toUpperCase();
  if (upper === 'GET' || upper === 'DELETE' || upper === 'HEAD') {
    return 'query';
  }
  return 'body';
}

/**
 * 判断方法是否有请求体
 *
 * POST / PUT / PATCH / DELETE 可能有 body
 * GET / HEAD 不应该有 body
 */
export function hasBody(method: string): boolean {
  const upper = method.toUpperCase();
  return upper === 'POST' || upper === 'PUT' || upper === 'PATCH' || upper === 'DELETE';
}
