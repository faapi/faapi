import { getSchemaName } from './schemaName';
import { InternalError } from '../errors/httpErrors';
import type { ValidationIssue, ValidationErrorCode } from '../errors/httpErrors';
import { importWithCacheBust } from '../utils/importWithCacheBust';

/**
 * 校验结果类型
 */
export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
  data: Record<string, unknown>;
}

/**
 * zod.js 模块导出格式
 *
 * 每个 handler 目录下的 zod.js 导出：
 * - `<SchemaName>Schema`：zod schema 对象（用于 safeParse 校验）
 *
 * query/params 的 schema 已在代码生成阶段用 z.preprocess 包裹了字符串转换逻辑
 * （number/boolean 字段），无需运行时再做 coerce。
 *
 * 无类型声明的方法不导出对应 Schema（值为 undefined）。
 */
interface SchemaModule {
  [key: string]: unknown;
}

/**
 * schema 模块缓存：schemaPath → SchemaModule
 *
 * dev 模式下 watch 触发 reloadRoutes 时通过 invalidateSchemaCache() 清空，
 * 下次请求重新 import（importWithCacheBust 会拼接时间戳绕过 ESM 缓存）。
 */
const moduleCache = new Map<string, SchemaModule>();

/**
 * 清空 schema 模块缓存（dev watch 模式下文件变化时调用）
 */
export function invalidateSchemaCache(): void {
  moduleCache.clear();
}

/**
 * 加载 schema 模块（带缓存）
 *
 * 首次调用时 import zod.js 并缓存，后续直接返回缓存。
 * dev 模式下 watch 触发 invalidateSchemaCache 后，下次调用重新 import。
 */
async function loadSchemaModule(schemaPath: string): Promise<SchemaModule> {
  let mod = moduleCache.get(schemaPath);
  if (!mod) {
    mod = (await importWithCacheBust(schemaPath)) as SchemaModule;
    moduleCache.set(schemaPath, mod);
  }
  return mod;
}

/**
 * 校验输入参数
 *
 * 流程：从 schemaPath import zod.js → zod safeParse
 *
 * schema 来源由调用方确保已生成：
 * - dev 模式：createApp 启动时 + watch 时调 generateSchemaFiles 生成 zod.js
 * - prd 模式：faapi build 时调 generateSchemaFiles 生成 zod.js
 *
 * coerce 说明：
 * - query/params 的 schema 在代码生成阶段已用 z.preprocess 包裹字符串转换逻辑
 *   （number: "1" → 1，boolean: "true" → true），运行时直接 safeParse 即可
 * - body 是 JSON 解析的天然 JS 类型，schema 不含 preprocess
 *
 * 三种状态：
 * - Schema 导出存在：执行 zod safeParse 校验
 * - Schema 导出 undefined（无类型声明）：跳过校验
 * - zod.js 文件不存在或 import 失败：抛 InternalError
 *
 * @param schemaPath zod.js 文件绝对路径
 * @param method HTTP 方法
 * @param inputType 输入类型
 * @param input 输入值
 */
export async function validateInput(
  schemaPath: string,
  method: string,
  inputType: 'query' | 'body' | 'params',
  input: unknown,
): Promise<ValidationResult> {
  const schemaName = getSchemaName(method, inputType);
  const schemaKey = `${schemaName}Schema`;

  let mod: SchemaModule;
  try {
    mod = await loadSchemaModule(schemaPath);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new InternalError(`Schema 模块加载失败: ${schemaPath}: ${reason}`);
  }

  const schema = mod[schemaKey];

  // 无类型声明：跳过校验
  if (schema === undefined || schema === null) {
    const data =
      typeof input === 'object' && input !== null && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : {};
    return { valid: true, issues: [], data };
  }

  // schema 必须是带 safeParse 的 zod schema
  if (
    typeof schema !== 'object' ||
    typeof (schema as { safeParse?: unknown }).safeParse !== 'function'
  ) {
    throw new InternalError(`Schema 不是有效的 zod schema: ${schemaPath}#${schemaName}`);
  }

  const inputObj =
    typeof input === 'object' && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};

  // zod safeParse 校验（query/params 的 preprocess 已在 schema 生成阶段内联）
  const zodSchema = schema as { safeParse: (v: unknown) => ZodSafeParseResult };
  const result = zodSchema.safeParse(inputObj);

  if (result.success) {
    const data =
      typeof result.data === 'object' && result.data !== null && !Array.isArray(result.data)
        ? (result.data as Record<string, unknown>)
        : {};
    return { valid: true, issues: [], data };
  }

  // 将 zod issues 转为 ValidationIssue
  const issues = mapZodIssues(result.error);
  return { valid: false, issues, data: inputObj };
}

/**
 * zod safeParse 成功结果
 */
interface ZodSafeParseSuccess {
  success: true;
  data: unknown;
}

/**
 * zod safeParse 失败结果
 */
interface ZodSafeParseError {
  success: false;
  error: {
    issues: Array<{
      path: (string | number)[];
      code: string;
      expected?: string;
      received?: string;
      message: string;
    }>;
  };
}

type ZodSafeParseResult = ZodSafeParseSuccess | ZodSafeParseError;

/**
 * 将 zod error issues 映射为框架的 ValidationIssue
 *
 * zod code → 框架 ValidationErrorCode 映射：
 * - invalid_type / invalid_union → TYPE_MISMATCH（422）
 * - too_small / too_big / invalid_string / invalid_date → INVALID_VALUE（422）
 * - invalid_enum_value → INVALID_VALUE（422）
 * - unrecognized_keys → INVALID_FORMAT（400）
 * - not_finite → COERCE_FAILED（422，query 字符串转 number 失败）
 * - custom → INVALID_VALUE（422）
 *
 * path 数组转为 dot 路径（如 ['user', 'address', 'city'] → 'user.address.city'）。
 */
function mapZodIssues(error: ZodSafeParseError['error']): ValidationIssue[] {
  return error.issues.map((issue) => {
    const code = mapZodCode(issue.code, issue.message);
    const path = issue.path.map(String).join('.') || '';
    return {
      path,
      code,
      expected: issue.expected ?? mapExpectedFromMessage(issue.message),
      received: issue.received ?? mapReceivedFromMessage(issue.message),
      message: issue.message,
    };
  });
}

/**
 * 映射 zod issue code 到框架 ValidationErrorCode
 */
function mapZodCode(zodCode: string, message: string): ValidationErrorCode {
  switch (zodCode) {
    case 'invalid_type':
    case 'invalid_union':
    case 'invalid_union_discriminator':
      return 'TYPE_MISMATCH';
    case 'unrecognized_keys':
      return 'INVALID_FORMAT';
    case 'invalid_enum_value':
    case 'invalid_string':
    case 'invalid_date':
    case 'too_small':
    case 'too_big':
    case 'invalid_intersection_types':
    case 'not_multiple_of':
      return 'INVALID_VALUE';
    case 'not_finite':
      // query 字符串转 number 失败（如 "abc" → NaN，被 z.preprocess 保留原值后 z.number() 报错）
      return 'COERCE_FAILED';
    case 'custom':
      // custom 错误通常是业务校验，归为 INVALID_VALUE
      return 'INVALID_VALUE';
    default:
      // 兜底：根据消息内容猜测
      if (message.includes('Required') || message.includes('required')) {
        return 'MISSING_FIELD';
      }
      return 'INVALID_VALUE';
  }
}

/**
 * 从 zod message 中提取期望类型（兜底）
 */
function mapExpectedFromMessage(message: string): string {
  // zod v3 message 示例："Expected string, received number"
  const match = message.match(/Expected\s+(\w+)/i);
  return match ? match[1]!.toLowerCase() : 'unknown';
}

/**
 * 从 zod message 中提取实际类型（兜底）
 */
function mapReceivedFromMessage(message: string): string {
  const match = message.match(/received\s+(\w+)/i);
  return match ? match[1]!.toLowerCase() : 'unknown';
}
