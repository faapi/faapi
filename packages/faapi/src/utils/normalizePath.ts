/**
 * 标准化路径：
 * - 将反斜杠替换为正斜杠
 * - 去除重复的斜杠
 * - 去除尾部斜杠
 * - 确保以 / 开头（如果非空）
 */
export function normalizePath(path: string): string {
  if (!path) return '';

  // 将反斜杠替换为正斜杠
  let result = path.replace(/\\/g, '/');

  // 去除重复的斜杠
  result = result.replace(/\/+/g, '/');

  // 去除尾部斜杠
  result = result.replace(/\/+$/, '');

  // 确保以 / 开头（如果非空）
  if (result && !result.startsWith('/')) {
    result = '/' + result;
  }

  return result;
}
