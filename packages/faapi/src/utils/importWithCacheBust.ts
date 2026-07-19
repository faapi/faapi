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
 * vitest 的 importActual 函数类型
 *
 * vi.importActual(path) 走 Vite SSR pipeline：
 * - 识别 vitest.config.ts 的 resolve.alias 与 tsconfig paths 别名
 * - 让 vi.mock 在加载的模块内生效
 */
type ImportActualFn = (path: string) => Promise<unknown>;

/**
 * 检测 vitest 的 vi.importActual（globals: true 时注入 globalThis.vi）
 *
 * 业务方 vitest.config.ts 需 test.globals: true，或在测试文件内
 * 显式 `import { vi } from 'vitest'` 后挂到 globalThis.vi。
 *
 * 不在 vitest 环境下返回 undefined，调用方回退到 Node 原生 import()。
 */
function getVitestImportActual(): ImportActualFn | undefined {
  const vi = (globalThis as { vi?: { importActual?: ImportActualFn } }).vi;
  if (typeof vi?.importActual !== 'function') return undefined;
  return vi.importActual.bind(vi);
}

/**
 * 动态 import 文件
 *
 * 两种加载路径：
 *
 * 1. **vitest 环境**（`globalThis.vi.importActual` 可用）：走 Vite SSR pipeline，
 *    识别 tsconfig paths 别名（如 `@/lib/db`）+ 让 `vi.mock` 生效。
 *    业务方在 vitest 下用 `createTestServer` 时自动启用。
 *
 * 2. **非 vitest 环境**：Node 原生 `import()`。watch 模式下拼接 `?t=<timestamp>`
 *    query 绕过 ESM 缓存；非 watch 模式等价普通 `import()`。
 *
 * @param filePath 文件绝对路径
 * @returns 模块导出对象
 */
export async function importWithCacheBust(filePath: string): Promise<Record<string, unknown>> {
  // vitest 环境优先走 Vite pipeline（识别 tsconfig paths + vi.mock）
  const importActual = getVitestImportActual();
  if (importActual) {
    return (await importActual(filePath)) as Record<string, unknown>;
  }

  // 否则走 Node 原生 ESM import
  let url = pathToFileURL(filePath).href;
  if (loadTs !== undefined) {
    url += `?t=${loadTs}`;
  }
  return (await import(url)) as Record<string, unknown>;
}
