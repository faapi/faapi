import type { AppBase, CreateAppOptions } from './createAppCore';
import { createAppBase, loadAndHydrateTools, loadAndHydrateAgents } from './createAppCore';
import { scanRoutes } from '../router/scanRoutes';
import { sortRoutes } from '../router/sortRoutes';
import { scanTools } from '../tools/scanTools';
import { TOOL_PATTERNS } from '../tools/scanTools';
import { generateToolArtifacts } from './generateToolArtifacts';
import { scanAgents } from '../agents/scanAgents';
import { DEFAULT_AGENT_PATTERNS } from '../agents/scanAgents';
import { generateAgentArtifacts } from './generateAgentArtifacts';
import { invalidateMiddlewareCache } from '../middleware/loadMiddlewares';
import { invalidateProgramCache } from '../ast/createProgram';
import { invalidateSchemaCache } from '../validator/validateInput';
import { setLoadTimestamp } from '../utils/importWithCacheBust';
import {
  clearCompiledFiles,
  clearGeneratedSchemas,
  deleteSchemaFiles,
  isDevOnDemandEnabled,
} from './compileOnDemand';

/** dev 应用接口（AppBase + reloadRoutes/reloadTools/reloadAgents 热替换） */
export interface DevApp extends AppBase {
  /** 重新水合路由清单 + 清 schema 缓存 + 更新 server 路由引用（dev 热替换用） */
  reloadRoutes(): Promise<void>;
  /** 重新扫描 tools + 重生成 faapi-tools.js + 清缓存（dev 热替换用） */
  reloadTools(): Promise<void>;
  /** 重新扫描 agents + 重生成 faapi-agents.js + 清缓存（dev 热替换用） */
  reloadAgents(): Promise<void>;
}

/**
 * dev 模式应用启动 API
 *
 * 在 createAppBase（共享逻辑）基础上增加 `reloadRoutes` 热替换能力，供 `faapi dev` watcher 调用。
 *
 * 与 createProdApp 的区别：
 * - dev：含 reloadRoutes（重新扫描路由 + 重新生成 schema + 清缓存 + 更新 server 路由引用）
 * - prod：精简，无 reloadRoutes（产物已固化，运行时不重建）
 *
 * 由 `devCommand` 直接调用，devCommand 持有 app 引用并传给 watcher。
 *
 * @example
 * ```ts
 * // devCommand 内部
 * const app = await createDevApp();
 * await app.listen();
 * startWatcher({ rootDir, app, devDist });
 * ```
 */
export async function createDevApp(options?: CreateAppOptions): Promise<DevApp> {
  const { app, ctx } = await createAppBase(options);

  const devApp = app as DevApp;

  devApp.reloadRoutes = async (): Promise<void> => {
    // 更新模块加载时间戳（ESM import 绕过缓存）
    setLoadTimestamp(Date.now());
    // 清理缓存（中间件/schema 已被 watcher 重新生成）
    invalidateMiddlewareCache();
    invalidateProgramCache();
    invalidateSchemaCache();
    // 清按需编译缓存（让被修改的 handler.js 重新编译）
    clearCompiledFiles();
    // 重新扫描路由
    // 不走 faapi-routes.js 重新 import——ESM 模块缓存难以可靠绕过，直接 scanRoutes 更稳定
    const reScanned = await scanRoutes(ctx.rootDir, ctx.patterns, ctx.dist);
    const sorted = sortRoutes(reScanned.routes);

    if (isDevOnDemandEnabled()) {
      // 按需模式：删除 stale zod.js（类型引用变化等），下次请求触发重新生成
      // 不全量 generateSchemaFiles——保持按需生成策略
      await deleteSchemaFiles(sorted, ctx.rootDir, ctx.dist);
      clearGeneratedSchemas();
    } else {
      // 非按需模式（兼容旧路径）：全量重新生成 zod.js
      const { generateSchemaFiles } = await import('./generateSchemaFiles');
      await generateSchemaFiles(sorted, ctx.rootDir, ctx.dist);
    }

    // 更新 app 和 server 路由引用
    ctx.updateRoutes(sorted, reScanned.wsRoutes);
  };

  devApp.reloadTools = async (): Promise<void> => {
    // 更新模块加载时间戳（ESM import 绕过缓存，让 faapi-tools.js 重新读取）
    setLoadTimestamp(Date.now());
    // 清 Program 缓存（tool 源码可能变化，AST 需重新分析）
    invalidateProgramCache();
    // 重新扫描 tools（零 import，仅读源码 + 正则提取函数名）
    const tools = await scanTools(ctx.rootDir, TOOL_PATTERNS);
    // 重生成 faapi-tools.js（含 AST 增强：description / inputTypeName）
    // 按需模式跳过 zod.js 生成——首次请求时按需生成（与 reloadRoutes 的策略一致）
    await generateToolArtifacts(tools, ctx.rootDir, ctx.dist, {
      skipSchema: isDevOnDemandEnabled(),
    });
    // 重新水合 faapi-tools.js 到 toolRegistry（reload 后需更新注册表）
    await loadAndHydrateTools(ctx.rootDir, ctx.dist);
  };

  devApp.reloadAgents = async (): Promise<void> => {
    // 更新模块加载时间戳（ESM import 绕过缓存，让 faapi-agents.js 重新读取）
    setLoadTimestamp(Date.now());
    // 清 Program 缓存（agent 源码可能变化，AST 需重新分析）
    invalidateProgramCache();
    // 重新扫描 agents（零 import，仅读源码 + 正则检测 config/run 导出）
    const agents = await scanAgents(ctx.rootDir, DEFAULT_AGENT_PATTERNS);
    // 重生成 faapi-agents.js（含 AST 增强：description / @agent 覆盖 / config 块字段）
    // agent 不生成 zod.js（无输入参数），无 skipSchema 选项
    await generateAgentArtifacts(agents, ctx.rootDir, ctx.dist);
    // 重新水合 faapi-agents.js 到 agentRegistry（reload 后需更新注册表）
    await loadAndHydrateAgents(ctx.rootDir, ctx.dist);
  };

  return devApp;
}
