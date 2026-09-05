import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { FaapiPlugin, PluginDeclaration } from '../config/pluginTypes';
import type { RequestHandler, UpgradeHandler } from '../config/pluginTypes';

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
 * @param declarations 插件声明列表
 * @param ctx 插件上下文（不含 wrap 能力，由本函数注入）
 * @param rootDir 项目根目录（`path` 声明解析基准）
 * @returns 包装器收集结果 + 失败清单
 */
export async function loadPlugins(
  declarations: PluginDeclaration[] | undefined,
  ctx: LoadPluginsContext,
  rootDir?: string,
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
      const mod = await import(resolveSpecifier(specifier, rootDir));
      const plugin: FaapiPlugin = mod.default ?? mod;

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

/**
 * 解析插件 specifier 为可 import 的目标
 *
 * - 包名 / 绝对路径：原样（绝对路径转 file URL，Windows 盘符路径裸 import 会解析失败）
 * - 相对路径（./、../）：相对项目根目录解析——此前直接 import 会相对 faapi 包自身
 *   产物文件解析，几乎必然 ERR_MODULE_NOT_FOUND 且报错指向 node_modules 深处
 */
function resolveSpecifier(specifier: string, rootDir: string | undefined): string {
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    const base = rootDir ?? process.cwd();
    return pathToFileURL(path.resolve(base, specifier)).href;
  }
  if (path.isAbsolute(specifier)) {
    return pathToFileURL(specifier).href;
  }
  return specifier;
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
