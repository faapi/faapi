import { schemaRegistry } from './schemaRegistry';
import { getSchemaName } from './schemaName';
import type { RuntimeType } from '../ast/resolveTypeNode';

/**
 * 单个参数的 schema 描述（简化版，供扩展包消费）
 */
export interface SchemaPropertyDescriptor {
  name: string;
  type: string;
  required: boolean;
}

/**
 * 单个输入源的 schema 描述
 */
export interface InputSchemaDescriptor {
  /** 输入源类型名（如 'Query'、'CreateUserBody'），无类型声明时 null */
  schemaName: string | null;
  /** 参数列表 */
  properties: SchemaPropertyDescriptor[];
}

/**
 * 查询指定路由 handler 的输入参数 schema
 *
 * 复用 schemaRegistry 已有的类型提取结果，避免重复 AST 分析。
 * 在 schema 尚未注册时返回 undefined。
 *
 * @param filePath handler 文件绝对路径
 * @param method HTTP 方法（GET/POST 等）
 * @param inputType 输入源类型（query/body/params）
 */
export function getSchemaProperties(
  filePath: string,
  method: string,
  inputType: 'query' | 'body' | 'params',
): InputSchemaDescriptor | undefined {
  const schemaName = getSchemaName(method, inputType);
  const entry = schemaRegistry.get(filePath, schemaName);

  // undefined = manifest 不完整；null = 无类型声明
  if (entry === undefined) return undefined;
  if (entry === null) {
    return { schemaName: null, properties: [] };
  }

  return {
    schemaName: schemaName,
    properties: entry.properties.map((prop) => ({
      name: prop.name,
      type: runtimeTypeToString(prop.type),
      required: !prop.optional,
    })),
  };
}

/**
 * 将 RuntimeType 转换为可读字符串
 */
function runtimeTypeToString(type: RuntimeType): string {
  switch (type.kind) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'bigint':
    case 'null':
    case 'undefined':
    case 'date':
      return type.kind;
    case 'literal':
      return JSON.stringify(type.value);
    case 'array':
      return `${runtimeTypeToString(type.element)}[]`;
    case 'tuple':
      return `[${type.elements.map((e) => (e.rest ? '...' : '') + runtimeTypeToString(e.type) + (e.optional ? '?' : '')).join(', ')}]`;
    case 'object':
      return 'object';
    case 'union':
      return type.members.map(runtimeTypeToString).join(' | ');
    case 'record':
      return `Record<${runtimeTypeToString(type.key)}, ${runtimeTypeToString(type.value)}>`;
    case 'ref':
      return type.name;
    case 'any':
    case 'unknown':
      return 'unknown';
    default:
      return 'unknown';
  }
}
