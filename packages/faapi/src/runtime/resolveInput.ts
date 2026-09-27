import { queryToObject } from '../utils/queryToObject';
import { parseJsonBody } from '../utils/parseJsonBody';
import { parseMultipart } from '../utils/parseMultipart';
import { getInputTypeForMethod } from './inputType';
import { ValidationError } from '../errors/httpErrors';

/** 输入解析结果：input 为校验管线的输入值，rawBody 为请求体原始文本（无则 undefined） */
export interface ResolvedInput {
  input: unknown;
  /** 请求体原始文本：JSON 为未解析字符串、form-urlencoded 为原始编码文本；multipart/无请求体为 undefined */
  rawBody?: string;
}

/**
 * 根据 HTTP 方法解析主输入
 *
 * - GET / DELETE / HEAD：主输入是 query（URL 查询参数）
 * - POST / PUT / PATCH：主输入是 body（请求体）
 *
 * 注意：DELETE 也可能有 body，但主输入（用于校验）是 query。
 * body 由 createServer 调 resolveBodyForQueryMethod 单独解析后注入
 * （同时消费请求体流，保证 keep-alive 连接可复用）。
 *
 * HTTP 传输语义：
 * - 空请求体（或纯空白）视为无 body，返回 null（有 schema 时 safeParse 失败 422，
 *   无 schema 透传；与 DELETE 的 body 空体行为完全一致）
 * - 请求体非空但 JSON 格式非法，抛 ValidationError(code=INVALID_FORMAT)，
 *   不再静默返回 null 导致后续报"字段缺失"
 *
 * @param method HTTP 方法
 * @param request Request 对象
 * @returns input（query 对象或 body 对象）+ rawBody（原始请求体文本）
 * @throws {ValidationError} 当请求体非空但 JSON 格式非法时
 */
export async function resolveInput(method: string, request: Request): Promise<ResolvedInput> {
  return resolveInputFromUrl(method, request, new URL(request.url));
}

/**
 * resolveInput 的热路径变体：URL 由调用方解析一次后传入
 *
 * createServer 每请求已持有解析好的 URL（pathname/searchParams 复用），
 * 通过此变体避免 query 分支的重复 `new URL(request.url)`。
 */
export async function resolveInputFromUrl(
  method: string,
  request: Request,
  url: URL,
): Promise<ResolvedInput> {
  const inputType = getInputTypeForMethod(method);

  // 主输入是 body 的方法：解析请求体
  if (inputType === 'body') {
    return parseBodyByContentType(request);
  }

  // 主输入是 query 的方法（GET / DELETE / HEAD）：从 URL 提取 query
  return { input: queryToObject(url.searchParams) };
}

/**
 * 按 Content-Type 解析请求体（POST/PUT/PATCH 主输入与 DELETE 次输入共用）
 *
 * - multipart/form-data：fields + files（二进制流，rawBody 为 undefined）
 * - application/x-www-form-urlencoded：字符串对象（rawBody 为原始编码文本）
 * - 默认按 JSON 解析（application/json 及其它未明确类型）
 *
 * 空请求体（或纯空白）视为无 body，input 为 null（rawBody 为 undefined）。
 */
async function parseBodyByContentType(request: Request): Promise<ResolvedInput> {
  const contentType = request.headers.get('content-type') ?? '';

  // multipart/form-data：字段 + 文件
  if (contentType.includes('multipart/form-data')) {
    return { input: await parseMultipart(request) };
  }

  // application/x-www-form-urlencoded：表单字段
  if (contentType.includes('application/x-www-form-urlencoded')) {
    const text = await request.text();
    if (isBlankText(text)) return { input: null };
    const params = new URLSearchParams(text);
    const obj: Record<string, string> = {};
    for (const [key, value] of params) {
      obj[key] = value;
    }
    return { input: obj, rawBody: text };
  }

  // 默认按 JSON 解析（application/json 及其它未明确类型）
  const text = await request.text();

  // 空请求体：视为无 body（有 schema 时校验失败，无 schema 透传）
  if (isBlankText(text)) {
    return { input: null };
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
  return { input: result.data, rawBody: text };
}

/** 空白文本判断（length 短路 + 正则扫描,避免 trim 的全量字符串拷贝） */
function isBlankText(text: string): boolean {
  return text.length === 0 || !/\S/.test(text);
}

/**
 * 解析"主输入是 query 但允许携带 body"的方法（DELETE）的请求体
 *
 * DELETE 的主输入（用于校验）是 query，但请求体流必须被消费（keep-alive 连接
 * 上有未读 body 时 Node 只能断开连接，无法复用），且 handler 声明 `body` 参数
 * 时应注入真正的请求体而非 query。
 *
 * Content-Type 分流与 POST/PUT/PATCH 主输入完全对称（JSON / form-urlencoded /
 * multipart）。解析结果的校验由 createServer 管线执行——handler 声明 `body`/
 * `form` 形参时存在 DELETEBody schema，校验通过后注入（Date 字段转换与 POST
 * body 一致；form 声明 coerce=true）。空请求体 input 为 null，与 POST 同路径：
 * 有 schema 时 safeParse 失败 422，无 schema 透传（handler 未声明 body 形参，
 * 无暴露面）。
 *
 * @throws {ValidationError} 当请求体非空但 JSON 格式非法时
 */
export async function resolveBodyForQueryMethod(request: Request): Promise<ResolvedInput> {
  return parseBodyByContentType(request);
}
