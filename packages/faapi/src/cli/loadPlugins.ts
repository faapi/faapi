import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { FaapiPlugin, PluginDeclaration } from '../config/pluginTypes';
import type { RequestHandler, UpgradeHandler } from '../config/pluginTypes';
import { ensureCompiled, isDevOnDemandEnabled } from './compileOnDemand';
import { compileProjectModules } from './compileConfig';

/** loadPlugins 的输入上下文（不含 wrap 能力，由 loadPlugins 内部注入） */
type LoadPluginsContext = Omit<
  import('../config/pluginTypes').PluginContext,
  'wrapHandler' | 'wrapUpgradeHandler'
>;

/** loadPlugins 返回的包装器收集结果 */
export interface PluginLoadResult {
  /** 插件注册的 HTTP handler 包装器（按注册顺序） */
  handlerWrappers: Array<(original: RequestHandler) => RequestHandler>;
  /** 插件注册的 WS upgrade handler 包装器（按注册顺序） */
  upgradeWrappers: Array<(original: UpgradeHandler | undefined) => UpgradeHandler>;
  /** 加载失败的插件（specifier + 原因）——调用方据此汇总报告或 fail-fast */
  failures: Array<{ specifier: string; reason: string }>;
}

/**
 * 加载并执行插件列表
 *
 * 遍历 config.plugins，动态 import 插件包，调用 setup(ctx)。
 * 插件在 server 创建后、listen 之前按声明顺序执行。
 *
 * 插件可通过 ctx.wrapHandler / ctx.wrapUpgradeHandler 注册包装函数，
 * 本函数收集后返回，由调用方在 listen 之前应用。
 *
 * 错误口径（单一语义，不再静默降级）：
 * - 单个插件加载/setup 失败不中断其他插件，但失败明细收集进 `failures` 并
 *   在加载完成后统一 `console.error` 汇总——鉴权/CORS 类插件静默丢失等同裸奔，
 *   必须对业务方可见
 * - 非法声明（resolveDeclaration 失败）与其他插件错误同口径收集，不崩启动
 * - `path` 声明相对项目根目录解析（`pathToFileURL(path.resolve(rootDir, path))`），
 *   此前直接 import 会相对 faapi 包自身产物解析，几乎必然失败且报错指向
 *   node_modules 深处
 *
 * 本地 TS 插件（`{ path: './plugins/xxx' }`，`.ts` 源码）的加载路径：
 * - 探测源文件（原样 → `.ts`/`.js` → `/index.ts`/`/index.js`），Node ESM 不做
 *   扩展名补全，无扩展名 file URL 直接 import 必然 `Cannot find module`
 * - 产物存在且不比源码旧 → import 产物（build 固化 / dev 已编译产物复用）
 * - `.ts` 源码 + dev 按需模式 → esbuild 逐文件编译到产物目录后 import 产物
 *   （src 内插件走 ensureCompiled 打平产物与 routes 同一运行时对象；src 外插件
 *   走 compileProjectModules，含依赖闭包与 specifier 重写——插件内部
 *   `import '../src/xxx'` 无扩展名由此生效）
 * - `.ts` 源码 + 非按需模式（prod / 编程式）且产物 stale → 明确报错指引 `faapi build`，
 *   不静默使用旧产物（与 handler 的 prod 语义一致：产物固化，import 失败即报错）
 *
 * @param declarations 插件声明列表
 * @param ctx 插件上下文（不含 wrap 能力，由本函数注入）
 * @param rootDir 项目根目录（`path` 声明解析基准）
 * @param dist 产物目录（dev 为 `.faapi`，prod 为 `dist`——本地 TS 插件按需编译/产物复用基准）
 * @returns 包装器收集结果 + 失败清单
 */
export async function loadPlugins(
  declarations: PluginDeclaration[] | undefined,
  ctx: LoadPluginsContext,
  rootDir?: string,
  dist?: string,
): Promise<PluginLoadResult> {
  const handlerWrappers: Array<(original: RequestHandler) => RequestHandler> = [];
  const upgradeWrappers: Array<(original: UpgradeHandler | undefined) => UpgradeHandler> = [];
  const failures: Array<{ specifier: string; reason: string }> = [];

  if (!declarations || declarations.length === 0) {
    return { handlerWrappers, upgradeWrappers, failures };
  }

  // 注入 wrap 能力到 ctx
  const fullCtx = {
    ...ctx,
    wrapHandler: (fn: (original: RequestHandler) => RequestHandler) => {
      handlerWrappers.push(fn);
    },
    wrapUpgradeHandler: (fn: (original: UpgradeHandler | undefined) => UpgradeHandler) => {
      upgradeWrappers.push(fn);
    },
  };

  const loaded = new Set<string>();

  for (const decl of declarations) {
    // 非法声明与其他插件错误同口径：收集进 failures，不崩启动
    let specifier: string;
    let options: unknown;
    let enable: boolean | undefined;
    try {
      ({ specifier, options, enable } = resolveDeclaration(decl));
    } catch (err) {
      failures.push({
        specifier: JSON.stringify(decl),
        reason: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    // enable 检查
    if (enable === false) continue;

    // 去重
    if (loaded.has(specifier)) {
      console.warn(`! Plugin already loaded: ${specifier}, skipping`);
      continue;
    }
    loaded.add(specifier);

    try {
      const mod = await importPluginModule(specifier, rootDir ?? process.cwd(), dist);
      const plugin: FaapiPlugin = mod.default ?? (mod as unknown as FaapiPlugin);

      if (typeof plugin.setup !== 'function') {
        failures.push({ specifier, reason: 'plugin has no setup function' });
        continue;
      }

      await plugin.setup({ ...fullCtx, options });
      console.log(`- Plugin loaded: ${plugin.name ?? specifier}`);
    } catch (err) {
      failures.push({
        specifier,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 失败汇总：单一出口，业务方启动日志一眼可见（鉴权类插件静默丢失不可接受）
  if (failures.length > 0) {
    console.error(
      `[faapi] ${failures.length} plugin(s) failed to load:\n` +
        failures.map((f) => `  - ${f.specifier}: ${f.reason}`).join('\n'),
    );
  }

  return { handlerWrappers, upgradeWrappers, failures };
}

/** TS 源文件后缀（需 esbuild 编译才能保证加载） */
const TS_EXTS = /\.(ts|tsx|mts|cts)$/;
/** JS 源文件后缀（Node ESM 可直接加载） */
const JS_EXTS = /\.(js|mjs|cjs|jsx)$/;

/**
 * 探测本地插件源文件
 *
 * 探测顺序：specifier 原样（已带扩展名）→ `.ts` → `.js` → `/index.ts` → `/index.js`。
 * Node ESM 对 file URL 不做扩展名补全，无扩展名声明必须由框架探测到实际文件。
 *
 * @param specifier 插件声明路径（相对项目根目录或绝对路径）
 * @param baseDir 项目根目录
 * @returns 源文件绝对路径，或 null（未找到）
 */
export function resolveLocalPluginSource(specifier: string, baseDir: string): string | null {
  const base = path.isAbsolute(specifier) ? specifier : path.resolve(baseDir, specifier);
  if ((TS_EXTS.test(base) || JS_EXTS.test(base)) && fs.existsSync(base)) return base;
  for (const ext of ['.ts', '.js']) {
    if (fs.existsSync(base + ext)) return base + ext;
  }
  for (const indexExt of ['/index.ts', '/index.js']) {
    if (fs.existsSync(base + indexExt)) return base + indexExt;
  }
  return null;
}

/**
 * 从源文件绝对路径推算产物绝对路径
 *
 * - src 内源文件：打平 src/ 前缀（与 compileDevRoutes/compileBuildRoutes 产物同一，
 *   运行时对象同一，instanceof 跨边界生效）
 * - src 外源文件：保留相对 rootDir 的路径结构（compileProjectModules 以 rootDir 为
 *   outbase，产物在 `<dist>/` 下保留结构）
 */
function mirrorProductPath(sourcePath: string, baseDir: string, distDir: string): string {
  let rel = path.relative(baseDir, sourcePath).replace(/\\/g, '/');
  if (rel.startsWith('src/')) rel = rel.slice(4);
  return path.resolve(distDir, rel.replace(TS_EXTS, '.js'));
}

/** 插件模块形态：default 导出优先 */
type PluginModule = { default?: FaapiPlugin } & Record<string, unknown>;

/** 产物是否比源码旧（stale） */
function isSourceNewer(sourcePath: string, productPath: string): boolean {
  try {
    return fs.statSync(sourcePath).mtimeMs > fs.statSync(productPath).mtimeMs;
  } catch {
    return true;
  }
}

/**
 * 加载插件模块
 *
 * - 包名（非相对/绝对路径）：原样 import，Node 按包解析
 * - 相对/绝对路径：探测源文件与产物，按「产物 fresh → 源码编译/直载」决策，
 *   详见 loadPlugins 注释的「本地 TS 插件的加载路径」
 *
 * @throws 找不到可加载目标或 prod 模式产物 stale 时抛错（带修复指引），进 failures 汇总
 */
async function importPluginModule(
  specifier: string,
  baseDir: string,
  dist: string | undefined,
): Promise<PluginModule> {
  const isRelative = specifier.startsWith('./') || specifier.startsWith('../');
  if (!isRelative && !path.isAbsolute(specifier)) {
    return import(specifier);
  }

  const distDir = dist ? path.resolve(baseDir, dist) : null;
  const sourcePath = resolveLocalPluginSource(specifier, baseDir);
  const productPath =
    sourcePath && distDir ? mirrorProductPath(sourcePath, baseDir, distDir) : null;

  // 产物可用：存在 且（源码不存在——部署机只发产物，或 产物不比源码旧）
  if (
    productPath !== null &&
    fs.existsSync(productPath) &&
    (sourcePath === null || !isSourceNewer(sourcePath, productPath))
  ) {
    return import(pathToFileURL(productPath).href);
  }

  // TS 源码：dev 按需编译后 import 产物
  if (sourcePath && TS_EXTS.test(sourcePath)) {
    if (!isDevOnDemandEnabled() || !distDir) {
      throw new Error(
        `Local plugin "${specifier}" has no up-to-date build artifact (dist is stale or missing). ` +
          `Run "faapi build" first, or use "faapi dev" for on-demand compilation.`,
      );
    }
    const relFromRoot = path.relative(baseDir, sourcePath).replace(/\\/g, '/');
    if (relFromRoot.startsWith('src/')) {
      // src 内插件：打平产物与 routes 同一（同一运行时对象）
      await ensureCompiled(sourcePath, baseDir, dist!);
    } else {
      // src 外插件：编译入口 + 依赖闭包（含插件 import 的 src 内模块）
      await compileProjectModules([sourcePath], baseDir, dist!);
    }
    if (productPath && fs.existsSync(productPath)) {
      return import(pathToFileURL(productPath).href);
    }
    // 编译已完成但产物仍缺失：落到统一报错（理论不可达，防御性兜底）
  }

  // JS 源码：Node 可直接加载，无需产物
  if (sourcePath && JS_EXTS.test(sourcePath)) {
    return import(pathToFileURL(sourcePath).href);
  }

  // 找不到可加载目标：给明确修复指引（此前仅报 Cannot find module，无法定位原因）
  const candidates = [
    `${specifier}.ts`,
    `${specifier}/index.ts`,
    `${specifier}.js`,
    `${specifier}/index.js`,
  ].map((c) => (path.isAbsolute(c) ? c : path.join(baseDir, c)));
  throw new Error(
    `Cannot find local plugin "${specifier}" (resolved from ${baseDir}). ` +
      `Expected one of:\n  ${candidates.join('\n  ')}\n` +
      `Create the plugin file (export default { name, setup(ctx) {...} }) or fix the path.`,
  );
}

/**
 * 解析插件声明为统一格式
 */
function resolveDeclaration(decl: PluginDeclaration): {
  specifier: string;
  options?: unknown;
  enable?: boolean;
} {
  if (typeof decl === 'string') {
    return { specifier: decl };
  }

  if (Array.isArray(decl)) {
    const [specifier, options] = decl;
    return { specifier, options };
  }

  if ('package' in decl) {
    return { specifier: decl.package, options: decl.options, enable: decl.enable };
  }

  if ('path' in decl) {
    return { specifier: decl.path, options: decl.options, enable: decl.enable };
  }

  throw new Error(`Invalid plugin declaration: ${JSON.stringify(decl)}`);
}
