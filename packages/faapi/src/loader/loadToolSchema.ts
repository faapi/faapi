import { existsSync } from 'node:fs';
import { importWithCacheBust } from '../utils/importWithCacheBust';
import { isDevOnDemandEnabled, getDevDist } from '../cli/compileOnDemand';
import { getRuntimeToolSchemaPath } from '../cli/generateToolArtifacts';
import type { ToolMetadata } from '../ast/extractToolMetadata';

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
 * 动态加载 tool 的 zod.js schema 模块
 *
 * 与 [loadToolModule](./loadToolModule.md) 对称——一个加载 handler.js（tool 函数），
 * 一个加载 zod.js（tool schema）。
 *
 * 行为：
 * - `tool.inputTypeName` 为 `undefined` → 返回 `undefined`（无 schema，用自由 schema）
 * - zod.js 文件不存在 → 返回 `undefined`（schema 可选，缺失用自由 schema）
 * - import 失败 / 导出名不匹配 → 返回 `undefined`
 *
 * 与 route schema 不同（route schema 缺失抛 `InternalError`），tool schema 是可选的——
 * `@faapi/agent` 的 `resolveToolSchema` 未提供时用自由 schema `{ type: 'object' }`，
 * LLM 自由传参，handler 内部自行处理参数合法性。
 *
 * @param tool tool 元数据（含 `filePath` + `inputTypeName`）
 * @param rootDir 项目根目录（用于计算 zod.js 绝对路径，`tool.filePath` 是相对路径时拼接）
 */
export async function loadToolSchema(
  tool: ToolMetadata,
  rootDir?: string,
): Promise<ToolSchemaModule | undefined> {
  // 无 inputTypeName → 无 zod.js
  if (!tool.inputTypeName) return undefined;

  const schemaName = `${tool.inputTypeName}Schema`;
  const dist = getDist();
  const zodPath = getRuntimeToolSchemaPath(tool.filePath, dist, rootDir ?? process.cwd());

  // zod.js 文件不存在 → 返回 undefined（schema 可选）
  if (!existsSync(zodPath)) return undefined;

  // import zod.js
  try {
    const mod = await importWithCacheBust(zodPath, isDevOnDemandEnabled());
    const schema = mod[`${tool.inputTypeName}Schema`];
    if (!schema) return undefined;
    return { schema, schemaName };
  } catch {
    // import 失败（语法错误等）→ 返回 undefined
    return undefined;
  }
}
