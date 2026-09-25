import fs from 'node:fs';
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
 * bustViteCache 分支的模块实例缓存：(filePath, mtime) → 模块
 *
 * 每请求 `?t=${Date.now()}` 新建 URL 会让 ESM 注册表为同一文件积累永不回收的模块
 * 实例（内存无界增长），且下游按模块对象做的 WeakMap 缓存（injection 分析等）
 * 永久 miss，每请求重跑 AST 解析。按 mtime 缓存后：同文件同 mtime 复用同一实例，
 * 文件重编译（mtime 变化）自动失效换新，无需显式清理（条目按路径收敛于项目规模）。
 */
const bustCache = new Map<string, { mtimeMs: number; module: Record<string, unknown> }>();

/** cache-bust 单调计数：同毫秒内多次失效加载也要生成不同 URL（Date.now 精度不足） */
let bustCounter = 0;

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
 * @param bustViteCache dev 按需模式下走 Node 原生 import（绕过 Vite SSR pipeline）。
 *   handler.js / zod.js 是已编译产物（别名已在编译时重写为相对路径），不需要 Vite alias 解析，
 *   直接走 Node 原生 import + 时间戳 query 避免 Vite SSR 缓存干扰。模块实例按
 *   (filePath, mtime) 缓存复用：同文件同 mtime 返回同一实例（下游 WeakMap 缓存可命中），
 *   文件重编译后自动失效。
 * @returns 模块导出对象
 */
export async function importWithCacheBust(
  filePath: string,
  bustViteCache = false,
): Promise<Record<string, unknown>> {
  // vitest 环境优先走 Vite pipeline（识别 tsconfig paths + vi.mock）
  const importActual = getVitestImportActual();
  if (importActual) {
    if (bustViteCache) {
      // dev 按需模式：handler.js / zod.js 是已编译产物（别名已在编译时重写为相对路径），
      // 不需要 Vite alias 解析，直接走 Node 原生 import + 时间戳 query 避免 Vite SSR 缓存干扰。
      // 按 (filePath, mtime) 复用模块实例——每请求新建 URL 是内存泄漏 + 缓存击穿
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(filePath).mtimeMs;
      } catch {
        // stat 失败按 mtime 0 走 import，模块加载按路径抛真实错误
      }
      const cached = bustCache.get(filePath);
      if (cached && cached.mtimeMs === mtimeMs) {
        return cached.module;
      }
      let url = pathToFileURL(filePath).href;
      url += `?t=${Date.now()}-${++bustCounter}`;
      const module = (await import(url)) as Record<string, unknown>;
      bustCache.set(filePath, { mtimeMs, module });
      return module;
    }
    return (await importActual(filePath)) as Record<string, unknown>;
  }

  // 否则走 Node 原生 ESM import
  let url = pathToFileURL(filePath).href;
  if (loadTs !== undefined) {
    url += `?t=${loadTs}`;
  }
  return (await import(url)) as Record<string, unknown>;
}
