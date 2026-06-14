import type { PropertyType } from '../ast/resolveTypeNode';
import type { RuntimeType } from '../ast/resolveTypeNode';
import type { ValidationIssue } from '../errors/httpErrors';

export interface CoerceResult {
  data: Record<string, unknown>;
  issues: ValidationIssue[];
}

/**
 * 将输入值根据类型信息做类型转换（coerce）
 * 主要用于 query/params，这些来源的值都是 string
 *
 * 转换规则：
 * - string → number：Number() 转换，NaN 则失败
 * - string → boolean：'true'/'1' → true，'false'/'0' → false，其他失败
 * - string → string：不转换
 * - string[] → number[]：逐元素转换
 * - 其他类型：不转换
 *
 * @param input 输入值
 * @param properties 属性类型列表（来自 SchemaEntry.properties）
 */
export function coerceInput(
  input: Record<string, unknown>,
  properties: PropertyType[],
): CoerceResult {
  const issues: ValidationIssue[] = [];
  const data: Record<string, unknown> = { ...input };

  for (const prop of properties) {
    const value = data[prop.name];
    const isPresent = prop.name in data;

    // 不存在的字段不转换
    if (!isPresent || value === undefined) continue;

    data[prop.name] = coerceValue(value, prop.type, prop.name, issues);
  }

  return { data, issues };
}

/**
 * 递归 coerce 值
 */
function coerceValue(
  value: unknown,
  type: RuntimeType,
  path: string,
  issues: ValidationIssue[],
): unknown {
  switch (type.kind) {
    case 'number':
      if (typeof value === 'string') {
        return coerceStringToNumber(value, path, issues);
      }
      return value;

    case 'boolean':
      if (typeof value === 'string') {
        return coerceStringToBoolean(value, path, issues);
      }
      return value;

    case 'array':
      // query 中的数组可能是逗号分隔字符串或重复 key
      if (typeof value === 'string') {
        // 单个字符串无法直接转为数组，保持原样
        return value;
      }
      if (Array.isArray(value)) {
        return value.map((item, i) => coerceValue(item, type.element, `${path}[${i}]`, issues));
      }
      return value;

    case 'tuple': {
      // 元组按位置 coerce 每个元素
      // - 非-rest 元素：用 type.elements[i] 对应类型
      // - rest 范围内的元素：用 rest.type；否则不应出现（validator 会报错）
      if (!Array.isArray(value)) return value;
      const restElement = type.elements.find((e) => e.rest);
      return value.map((item, i) => {
        const elem = type.elements[i];
        if (elem && !elem.rest) {
          return coerceValue(item, elem.type, `${path}[${i}]`, issues);
        }
        // rest 范围内的元素
        if (restElement) {
          return coerceValue(item, restElement.type, `${path}[${i}]`, issues);
        }
        return item;
      });
    }

    case 'union':
      // 尝试 coerce 到联合类型中的每个成员，返回第一个成功的
      for (const member of type.members) {
        const tempIssues: ValidationIssue[] = [];
        const coerced = coerceValue(value, member, path, tempIssues);
        if (tempIssues.length === 0) {
          return coerced;
        }
      }
      return value;

    case 'literal':
      // 数值字面量（来自数值枚举）:将 query 字符串转为数字,由 validator 检查是否匹配
      if (typeof type.value === 'number' && typeof value === 'string' && value.trim() !== '') {
        const num = Number(value);
        if (!Number.isNaN(num)) return num;
      }
      return value;

    case 'object':
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        const obj = value as Record<string, unknown>;
        const result: Record<string, unknown> = {};
        for (const prop of type.properties) {
          if (prop.name in obj) {
            result[prop.name] = coerceValue(
              obj[prop.name],
              prop.type,
              `${path}.${prop.name}`,
              issues,
            );
          }
        }
        return { ...obj, ...result };
      }
      return value;

    default:
      // string / date / record / any / null / undefined / bigint / tuple 不转换
      return value;
  }
}

/**
 * string → number
 */
function coerceStringToNumber(
  value: string,
  path: string,
  issues: ValidationIssue[],
): number | string {
  if (value.trim() === '') {
    issues.push({
      path,
      code: 'COERCE_FAILED',
      expected: 'number',
      received: 'string',
      message: `字段 "${path}" 类型转换失败：无法将 "${value}" 转为 number`,
    });
    return value;
  }
  const num = Number(value);
  if (Number.isNaN(num)) {
    issues.push({
      path,
      code: 'COERCE_FAILED',
      expected: 'number',
      received: 'string',
      message: `字段 "${path}" 类型转换失败：无法将 "${value}" 转为 number`,
    });
    return value;
  }
  return num;
}

/**
 * string → boolean
 */
function coerceStringToBoolean(
  value: string,
  path: string,
  issues: ValidationIssue[],
): boolean | string {
  if (value === 'true' || value === '1') {
    return true;
  }
  if (value === 'false' || value === '0') {
    return false;
  }
  issues.push({
    path,
    code: 'COERCE_FAILED',
    expected: 'boolean',
    received: 'string',
    message: `字段 "${path}" 类型转换失败：无法将 "${value}" 转为 boolean`,
  });
  return value;
}
