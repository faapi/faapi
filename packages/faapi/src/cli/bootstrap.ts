import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ensureCompiled, isProductFresh } from './compileOnDemand';

/**
 * src/bootstrap.ts 约定启动文件（机制契约见 [bootstrap.md](./bootstrap.md)）
 *
 * `createProdApp` / `createDevApp` 在 createAppBase 之后、返回之前调用本模块——
 * 业务在 bootstrap 内经 `getApp().on(...)` 完成全部事件订阅（含启动期三事件），
 * 窗口由框架给出：app 已创建（getApp 可用）、事件未发射（listen 未调用）。
 */

/** 约定源路径（相对项目根目录，不进任何路由/tool/agent/task 扫描器） */
const BOOTSTRAP_SOURCE = 'src/bootstrap.ts';

/** bootstrap 模块形态：default 导出可选 */
interface BootstrapModule {
  default?: () => Promise<void> | void;
}

/**
 * 加载并执行 src/bootstrap.ts（无该文件零开销跳过）
 *
 * - **prod 形态**（`onDemand` 缺省）：`faapi build` 的 compileSourceFiles 已产出
 *   `<dist>/bootstrap.js`——探测存在 → 动态 import → `await default()`；源码在场
 *   且比产物新（改源码没重新 build）→ 抛错指引 `faapi build`（产物固化语义，与
 *   handler/本地 TS 插件一致）；产物缺失（源码也不在）→ 跳过
 * - **dev 形态**（`onDemand: true`，`createDevApp` 传入）：源码存在 →
 *   `ensureCompiled`（依赖闭包 + mtime 缓存，与 agent handler 同款）编译到
 *   `<dist>/bootstrap.js` → import 执行
 *
 * @throws bootstrap 模块加载失败或 default 执行抛错——原样上抛（调用方
 *         `createProdApp`/`createDevApp` reject，listen 不执行、端口不暴露）
 */
export async function loadBootstrap(
  rootDir: string,
  dist: string,
  options?: { onDemand?: boolean },
): Promise<void> {
  const sourceAbs = path.resolve(rootDir, BOOTSTRAP_SOURCE);
  const productAbs = path.resolve(rootDir, dist, 'bootstrap.js');
  const hasSource = fs.existsSync(sourceAbs);

  if (hasSource && options?.onDemand) {
    // dev：依赖闭包编译（mtime 缓存——未变化的文件跳过，只补缺口）
    await ensureCompiled(sourceAbs, rootDir, dist);
  } else if (hasSource && fs.existsSync(productAbs) && !isProductFresh(sourceAbs, productAbs)) {
    // prod：产物固化语义——源码比产物新（改了源码没重新 build）显式失败，不静默用旧产物
    throw new Error(
      `bootstrap source "${BOOTSTRAP_SOURCE}" is newer than its build artifact ` +
        `"${path.relative(rootDir, productAbs)}". Run "faapi build" to regenerate.`,
    );
  }

  if (!fs.existsSync(productAbs)) return;

  const mod = (await import(pathToFileURL(productAbs).href)) as BootstrapModule;
  if (mod.default) await mod.default();
}
