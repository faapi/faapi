import { schemaRegistry } from './schemaRegistry';
import { getSchemaName } from './schemaName';
import { coerceInput } from './coerceInput';
import { InternalError } from '../errors/httpErrors';
import type { ValidationResult } from '../ast/generateValidatorCode';

/**
 * 校验输入参数
 *
 * 流程：从 schemaRegistry 查询 schema → 类型转换（仅 query）→ 调用校验函数
 *
 * schema 来源由调用方确保已注册：
 * - dev 模式：启动时全量提取并生成函数，watch 时全量重建
 * - prd 模式：启动时从 dist/faapi-schema.js import 加载
 *
 * 三种状态：
 * - SchemaEntry：执行校验
 * - null：无类型声明，跳过校验
 * - undefined：manifest 不完整，抛 InternalError
 *
 * @param filePath 路由文件路径
 * @param method HTTP 方法
 * @param inputType 输入类型
 * @param input 输入值
 */
export async function validateInput(
  filePath: string,
  method: string,
  inputType: 'query' | 'body' | 'params',
  input: unknown,
): Promise<ValidationResult> {
  const schemaName = getSchemaName(method, inputType);
  const entry = schemaRegistry.get(filePath, schemaName);

  // manifest 不完整：schema 未注册
  if (entry === undefined) {
    throw new InternalError(`Schema 未注册: ${filePath}#${schemaName}`);
  }

  // 无类型声明：跳过校验
  if (entry === null) {
    const data =
      typeof input === 'object' && input !== null && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : {};
    return { valid: true, issues: [], data };
  }

  const inputObj =
    typeof input === 'object' && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};

  // 类型转换（coerce）：仅 query 需要，因为 URL 参数都是 string
  let dataToValidate = inputObj;
  if (inputType === 'query') {
    const { data: coercedData, issues: coerceIssues } = coerceInput(inputObj, entry.properties);

    if (coerceIssues.length > 0) {
      return {
        valid: false,
        issues: coerceIssues,
        data: coercedData,
      };
    }
    dataToValidate = coercedData;
  }

  // 调用校验函数
  return entry.validator(dataToValidate);
}
