import { existsSync } from 'node:fs';
import { importWithCacheBust } from '../utils/importWithCacheBust';
import { isDevOnDemandEnabled, getDevDist } from '../cli/compileOnDemand';
import { getRuntimeToolSchemaPath } from '../cli/generateToolArtifacts';

/**
 * 加载后的 tool schema 模块
 *
 * 与 [ToolModule](./loadToolModule.md) 对称——`schema` 替代 `handler`。
 *
 * `schema` 是 `unknown` 类型——faapi 核心不依赖 zod（zod 是 peerDep），
 * `zod.js` 由业务方安装的 zod 创建，`@faapi/agent` 负责断言为 zod schema 后
 * 调 `z.toJSONSchema` / `safeParse`。
 */
export interface ToolSchemaModule {
  /** zod schema 对象（由业务方安装的 zod 创建） */
  schema: unknown;
  /** schema 导出名（如 `WeatherInputSchema`，用于日志/调试） */
  schemaName: string;
}

/**
 * 获取当前 dist 目录
 *
 * dev 按需模式：`getDevDist()`（`.faapi`，dev 产物目录固定不可修改）
 * prod 模式：`process.env.FAAPI_DIST`（默认 `dist`，可通过 `--dist` 修改）
 */
function getDist(): string {
  if (isDevOnDemandEnabled()) {
    return getDevDist() ?? '.faapi';
  }
  return process.env.FAAPI_DIST ?? 'dist';
}

/**
 * 计算 tool 的 zod.js 绝对路径（纯路径计算，无 fs 访问）
 *
 * 与 [loadToolSchema](./loadToolSchema.ts) 内部使用的路径逻辑同源（共享 `getDist()`），
/**
 * zod.js 定位的最小来源结构——`ToolMetadata` 与 `AgentMetadata`（派发入参 schema
 * 声明场景）均满足，加载器无需感知来源差异
 */
export interface SchemaSourceRef {
  /** 源码/产物相对路径（与 zod.js 同级，推导 zod.js 路径用） */
  filePath: string;
  /** schema 类型名（`undefined` = 无 schema 声明） */
  inputTypeName?: string;
}

/**
 * 计算 zod.js 的绝对路径（纯路径计算，无 fs 访问）
 *
 * 与 [loadToolSchema](./loadToolSchema.ts) 内部使用的路径逻辑同源（共享 `getDist()`），
 * 供 `@faapi/agent` 的跨请求 schema 缓存用作缓存键 + mtime 校验目标。
 *
 * @param ref schema 来源元数据（tool / agent 均可，含 `filePath`）
 * @param rootDir 项目根目录（`ref.filePath` 是相对路径时拼接）
 */
export function getToolSchemaPath(ref: SchemaSourceRef, rootDir?: string): string {
  const dist = getDist();
  return getRuntimeToolSchemaPath(ref.filePath, dist, rootDir ?? process.cwd());
}

/**
 * 动态加载 zod.js schema 模块（tool input 与 agent 派发入参共用）
 *
 * 与 [loadToolModule](./loadToolModule.md) 对称——一个加载 handler.js（tool 函数），
 * 一个加载 zod.js（schema 模块）。tool 的 zod.js 与 handler.js 同级；agent 声明
 * `Input` 时同样生成同级 zod.js（见 generateAgentArtifacts），同一加载器服务两类来源。
 *
 * 行为：
 * - `ref.inputTypeName` 为 `undefined` → 返回 `undefined`（无 schema 声明）
 * - zod.js 文件不存在 → 返回 `undefined`（schema 缺失，调用方按各自语义处理——
 *   tool 用自由 schema `{ type: 'object' }`；agent 派发入参在声明了 `inputTypeName`
 *   时视为产物异常，由 `@faapi/agent` 侧显式抛错）
 * - import 失败 / 导出名不匹配 → 返回 `undefined`
 *
 * @param ref schema 来源元数据（tool / agent 均可，含 `filePath` + `inputTypeName`）
 * @param rootDir 项目根目录（用于计算 zod.js 绝对路径，`ref.filePath` 是相对路径时拼接）
 */
export async function loadToolSchema(
  ref: SchemaSourceRef,
  rootDir?: string,
): Promise<ToolSchemaModule | undefined> {
  // 无 inputTypeName → 无 zod.js
  if (!ref.inputTypeName) return undefined;

  const schemaName = `${ref.inputTypeName}Schema`;
  const zodPath = getToolSchemaPath(ref, rootDir);

  // zod.js 文件不存在 → 返回 undefined（schema 可选）
  if (!existsSync(zodPath)) return undefined;

  // import zod.js
  try {
    const mod = await importWithCacheBust(zodPath, isDevOnDemandEnabled());
    const schema = mod[`${ref.inputTypeName}Schema`];
    if (!schema) return undefined;
    return { schema, schemaName };
  } catch {
    // import 失败（语法错误等）→ 返回 undefined
    return undefined;
  }
}
