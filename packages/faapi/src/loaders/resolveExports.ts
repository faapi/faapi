/**
 * 从模块中解析出指定名称的导出
 *
 * 解析顺序：
 * 1. 具名导出：export function GET() {}
 * 2. 默认导出的对象属性：export default { GET() {} }
 *
 * @param module 动态 import 得到的模块对象
 * @param exportName 导出名（如 'GET'）
 */
export function resolveExport(module: Record<string, unknown>, exportName: string): unknown {
  // 1. 具名导出
  if (exportName in module && typeof module[exportName] !== 'undefined') {
    return module[exportName];
  }

  // 2. 默认导出的对象属性
  const defaultExport = module.default;
  if (defaultExport !== null && typeof defaultExport === 'object') {
    const value = (defaultExport as Record<string, unknown>)[exportName];
    if (value !== undefined) {
      return value;
    }
  }

  return undefined;
}
