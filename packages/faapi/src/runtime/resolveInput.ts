import { queryToObject } from '../utils/queryToObject';
import { parseJsonBody } from '../utils/parseJsonBody';
import { parseMultipart } from '../utils/parseMultipart';
import { getInputTypeForMethod } from './inputType';
import { ValidationError } from '../errors/httpErrors';

/**
 * 根据 HTTP 方法解析主输入
 *
 * - GET / DELETE / HEAD：主输入是 query（URL 查询参数）
 * - POST / PUT / PATCH：主输入是 body（请求体）
 *
 * 注意：DELETE 也可能有 body，但主输入（用于校验）是 query。
 * body 通过 injectParams 单独注入。
 *
 * HTTP 传输语义：
 * - 空请求体（或纯空白）视为无 body，返回 null（handler 可不声明 body 参数）
 * - 请求体非空但 JSON 格式非法，抛 ValidationError(code=INVALID_FORMAT)，
 *   不再静默返回 null 导致后续报"字段缺失"
 *
 * @param method HTTP 方法
 * @param request Request 对象
 * @returns 解析后的输入值（query 对象或 body 对象）
 * @throws {ValidationError} 当请求体非空但 JSON 格式非法时
 */
export async function resolveInput(method: string, request: Request): Promise<unknown> {
  const inputType = getInputTypeForMethod(method);

  // 主输入是 body 的方法：解析请求体
  if (inputType === 'body') {
    const contentType = request.headers.get('content-type') ?? '';

    // multipart/form-data：字段 + 文件
    if (contentType.includes('multipart/form-data')) {
      return parseMultipart(request);
    }

    // application/x-www-form-urlencoded：表单字段
    if (contentType.includes('application/x-www-form-urlencoded')) {
      const text = await request.text();
      if (text.trim() === '') return null;
      const params = new URLSearchParams(text);
      const obj: Record<string, string> = {};
      for (const [key, value] of params) {
        obj[key] = value;
      }
      return obj;
    }

    // 默认按 JSON 解析（application/json 及其它未明确类型）
    const text = await request.text();

    // 空请求体：视为无 body（handler 可不声明 body 参数）
    if (text.trim() === '') {
      return null;
    }

    // 非空请求体：必须能解析为 JSON,否则是格式错误
    const result = parseJsonBody(text);
    if (!result.success) {
      throw new ValidationError('请求体不是合法的 JSON', [
        {
          path: 'body',
          code: 'INVALID_FORMAT',
          expected: 'JSON',
          received: 'text',
          message: '请求体不是合法的 JSON',
        },
      ]);
    }
    return result.data;
  }

  // 主输入是 query 的方法（GET / DELETE / HEAD）：从 URL 提取 query
  const url = new URL(request.url);
  return queryToObject(url.searchParams);
}
