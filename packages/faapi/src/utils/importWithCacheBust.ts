import { pathToFileURL } from 'node:url';

/**
 * 获取当前模块加载时间戳（watch 模式下用于绕过 ESM 缓存）
 *
 * 由 startCommand 在 watch 模式下设置到 globalThis.__FAAPI_LOAD_TS__。
 */
export function getLoadTimestamp(): number | undefined {
  return (globalThis as Record<string, unknown>).__FAAPI_LOAD_TS__ as number | undefined;
}

/**
 * 动态 import 文件，watch 模式下拼接时间戳绕过 ESM 缓存
 *
 * @param filePath 文件绝对路径
 * @returns 模块导出对象
 */
export async function importWithCacheBust(filePath: string): Promise<Record<string, unknown>> {
  let url = pathToFileURL(filePath).href;
  const ts = getLoadTimestamp();
  if (ts !== undefined) {
    url += `?t=${ts}`;
  }
  return (await import(url)) as Record<string, unknown>;
}
