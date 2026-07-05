import { pathToFileURL } from 'node:url';

/**
 * 当前模块加载时间戳（watch 模式下用于绕过 ESM 缓存）
 *
 * 由 createDevApp.reloadRoutes 调用 setLoadTimestamp 设置。
 * ES 模块单例保证所有 import 此模块的地方共享同一个值，无需 globalThis。
 */
let loadTs: number | undefined;

export function setLoadTimestamp(ts: number): void {
  loadTs = ts;
}

/**
 * 动态 import 文件，watch 模式下拼接时间戳绕过 ESM 缓存
 *
 * @param filePath 文件绝对路径
 * @returns 模块导出对象
 */
export async function importWithCacheBust(filePath: string): Promise<Record<string, unknown>> {
  let url = pathToFileURL(filePath).href;
  if (loadTs !== undefined) {
    url += `?t=${loadTs}`;
  }
  return (await import(url)) as Record<string, unknown>;
}
