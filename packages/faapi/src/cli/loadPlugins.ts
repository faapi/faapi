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
 * @param declarations 插件声明列表
 * @param ctx 插件上下文（不含 wrap 能力，由本函数注入）
 * @returns 包装器收集结果
 */
export async function loadPlugins(
  declarations: PluginDeclaration[] | undefined,
  ctx: LoadPluginsContext,
): Promise<PluginLoadResult> {
  const handlerWrappers: Array<(original: RequestHandler) => RequestHandler> = [];
  const upgradeWrappers: Array<(original: UpgradeHandler | undefined) => UpgradeHandler> = [];

  if (!declarations || declarations.length === 0) {
    return { handlerWrappers, upgradeWrappers };
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
    const { specifier, options, enable } = resolveDeclaration(decl);

    // enable 检查
    if (enable === false) continue;

    // 去重
    if (loaded.has(specifier)) {
      console.warn(`! Plugin already loaded: ${specifier}, skipping`);
      continue;
    }
    loaded.add(specifier);

    try {
      const mod = await import(specifier);
      const plugin: FaapiPlugin = mod.default ?? mod;

      if (typeof plugin.setup !== 'function') {
        console.warn(`! Plugin ${specifier} has no setup function, skipping`);
        continue;
      }

      await plugin.setup({ ...fullCtx, options });
      console.log(`- Plugin loaded: ${plugin.name ?? specifier}`);
    } catch (err) {
      console.warn(
        `! Failed to load plugin ${specifier}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { handlerWrappers, upgradeWrappers };
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

  // 不应该到这里
  throw new Error(`Invalid plugin declaration: ${JSON.stringify(decl)}`);
}
