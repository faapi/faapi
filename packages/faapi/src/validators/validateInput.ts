import { getSchemaName } from './schemaName';
import { InternalError } from '../errors/httpErrors';
import type { ValidationIssue, ValidationErrorCode } from '../errors/httpErrors';
import { importWithCacheBust } from '../utils/importWithCacheBust';
import { isDevOnDemandEnabled } from '../cli/compileOnDemand';

/**
 * 校验结果类型
 *
 * data 为校验/解析后的原始值（通常为对象；数组 body 为数组，
 * 顶层 primitive body——如 `type POSTBody = string`——为对应原始值）。
 */
export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
  data: unknown;
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
    // dev 按需模式下走 Node 原生 import 绕过 Vite SSR 缓存
    // （zod.js 是已编译产物，不需要 Vite alias 解析）
    mod = (await importWithCacheBust(schemaPath, isDevOnDemandEnabled())) as SchemaModule;
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

  // 无类型声明：跳过校验，input 原样透传（数组/原始值 body 不再静默替换为 {}）
  if (schema === undefined || schema === null) {
    return { valid: true, issues: [], data: input };
  }

  // schema 必须是带 safeParse 的 zod schema
  if (
    typeof schema !== 'object' ||
    typeof (schema as { safeParse?: unknown }).safeParse !== 'function'
  ) {
    throw new InternalError(`Schema 不是有效的 zod schema: ${schemaPath}#${schemaName}`);
  }

  // zod safeParse 校验：input 原样传入（schema 生成端支持数组/顶层 primitive body，
  // 预先替换数组会使命中 z.array 的合法 body 永远失败且 issue 误导为 received object）
  // query/params 的 preprocess 已在 schema 生成阶段内联
  const zodSchema = schema as { safeParse: (v: unknown) => ZodSafeParseResult };
  const result = zodSchema.safeParse(input);

  if (result.success) {
    // 解析后的数据原样返回（z.array schema 的 data 是数组，顶层 primitive 是原始值）
    return { valid: true, issues: [], data: result.data };
  }

  // 将 zod issues 转为 ValidationIssue
  const issues = mapZodIssues(result.error);
  return { valid: false, issues, data: input };
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
 * 将 zod v4 error issues 映射为框架的 ValidationIssue
 *
 * zod code → 框架 ValidationErrorCode 映射：
 * - invalid_type（received 非 undefined） / invalid_union → TYPE_MISMATCH（422）
 * - invalid_type（received === 'undefined'，即缺失必填字段）→ MISSING_FIELD（400）
 * - unrecognized_keys → INVALID_FORMAT（400）
 * - invalid_value / invalid_format（v4 的 email/url/uuid/regex 等格式检查）/
 *   invalid_key / invalid_element（v4 的 record/map 元素检查）/
 *   too_small / too_big / invalid_intersection_types / not_multiple_of / custom
 *   → INVALID_VALUE（422）
 *
 * path 数组转为 dot 路径（如 ['user', 'address', 'city'] → 'user.address.city'）。
 */
function mapZodIssues(error: ZodSafeParseError['error']): ValidationIssue[] {
  return error.issues.map((issue) => {
    const code = mapZodCode(issue);
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

interface ZodIssueLike {
  code: string;
  expected?: string;
  received?: string;
  message: string;
}

/**
 * 映射 zod v4 issue code 到框架 ValidationErrorCode
 *
 * zod v4 已移除 invalid_string（v3 遗留），格式类检查（email/url/uuid/regex）
 * 产出 invalid_format；record/map 的键/元素检查产出 invalid_key / invalid_element。
 */
function mapZodCode(issue: ZodIssueLike): ValidationErrorCode {
  switch (issue.code) {
    case 'invalid_type':
      // zod v4 对缺失必填字段产出 invalid_type，无独立 missing code；
      // received 字段缺失，"received undefined" 只出现在 message 中
      if (issue.received === 'undefined' || /received undefined/i.test(issue.message)) {
        return 'MISSING_FIELD';
      }
      return 'TYPE_MISMATCH';
    case 'invalid_union':
    case 'invalid_union_discriminator':
      return 'TYPE_MISMATCH';
    case 'unrecognized_keys':
      return 'INVALID_FORMAT';
    case 'invalid_value':
    case 'invalid_format':
    case 'invalid_key':
    case 'invalid_element':
    case 'too_small':
    case 'too_big':
    case 'invalid_intersection_types':
    case 'not_multiple_of':
    case 'custom':
      return 'INVALID_VALUE';
    default:
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
