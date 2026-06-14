/**
 * 根据 HTTP 方法和输入类型生成 schema 类型名
 * GET + query -> GETQuery
 * POST + body -> POSTBody
 * GET + params -> GETParams
 */
export function getSchemaName(method: string, inputType: 'query' | 'body' | 'params'): string {
  return `${method.toUpperCase()}${inputType.charAt(0).toUpperCase() + inputType.slice(1)}`;
}
