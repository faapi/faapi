import { statSync } from 'node:fs';
import { z } from 'zod';
import { loadToolSchema, getToolSchemaPath } from './loadToolSchema';
import type { SchemaSourceRef } from './loadToolSchema';

export type { SchemaSourceRef } from './loadToolSchema';

/**
 * tool schema 解析结果
 *
 * 由 schema 解析工厂产出，提供 JSON Schema（给 LLM）和校验函数（给执行前校验）。
 * - `jsonSchema` —— 发给 LLM 作为 tool 参数描述
 * - `validate` —— 执行前校验 LLM 返回的参数，失败时返回 `{ error }` 回传 LLM 重试
 *
 * 契约消费方是 `@faapi/agent` 的 `AgentDeps.resolveToolSchema` /
 * `AgentDeps.resolveAgentInputSchema`（该包 re-export 此类型，导入路径不变）。
 */
export interface ToolSchemaResolution {
  /** tool 参数的 JSON Schema（发给 LLM） */
  jsonSchema: Record<string, unknown>;
  /** 执行前校验函数（成功返回 coerce 后的 value，失败返回 error） */
  validate: (
    input: Record<string, unknown>,
  ) => { ok: true; value: Record<string, unknown> } | { ok: false; error: string };
}

/**
 * 单次解析（无缓存）——loadToolSchema 加载 zod.js → 生成 JSON Schema + 校验函数
 *
 * @param ref schema 来源元数据（tool / agent 均可，含 filePath / inputTypeName）
 * @param rootDir 项目根目录
 * @param dist 产物目录（缺省走 dev on demand / FAAPI_DIST 全局解析）
 * @returns `ToolSchemaResolution` 或 `undefined`（zod.js 不存在 / 无 inputTypeName）
 */
async function resolveToolSchemaImpl(
  ref: SchemaSourceRef,
  rootDir: string,
  dist?: string,
): Promise<ToolSchemaResolution | undefined> {
  const schemaMod = await loadToolSchema(ref, rootDir, dist);
  if (!schemaMod) return undefined;
  const schema = schemaMod.schema as z.ZodType;
  return {
    jsonSchema: z.toJSONSchema(schema),
    validate: (input) => {
      const result = schema.safeParse(input);
      if (result.success) {
        return { ok: true as const, value: result.data as Record<string, unknown> };
      }
      return { ok: false as const, error: result.error.message };
    },
  } satisfies ToolSchemaResolution;
}

/**
 * 创建带 mtime 缓存的 schema 解析器（tool input 与 agent 派发入参共用）
 *
 * 返回的函数同时满足 `AgentDeps.resolveToolSchema` / `AgentDeps.resolveAgentInputSchema`
 * 两个签名（参数为最小结构 [SchemaSourceRef](./loadToolSchema.md)），供共用：
 * - `@faapi/agent` 插件 setup（传 `ctx.rootDir`，同一实例注入两个 deps，root +
 *   sub-agent 共享同一闭包缓存）
 * - 任务内组装 Agent（缺省 `process.cwd()`——faapi 服务进程 cwd 即项目根；
 *   建议任务文件模块级创建一次）
 * - 测试设施 `createAgentTestHarness`（显式传 `dist` 指向临时产物目录）
 *
 * **缓存语义**（闭包级 `Map<key, { mtimeMs, resolution }>`）：
 * - 缓存键 `zodPath#inputTypeName`，每次查找 `statSync` 一次做 mtime 自校验——
 *   mtime 变化即重新解析（dev reload 重生成 zod.js 后自愈，prod 产物固化永远命中）
 * - in-flight Promise 直接入缓存：同一来源的并发调用共享同一次解析
 * - 每次 `createToolSchemaResolver` 调用返回独立缓存的 resolver
 *
 * zod.js 缺失 / 无 `inputTypeName` 时解析结果为 `undefined`——tool 侧用自由 schema
 * `{ type: 'object' }`；agent 派发侧对「声明了 `inputTypeName` 但解析为 `undefined`」
 * 的产物异常语义（显式抛错）由 `@faapi/agent` 的 Agent 类定义，本工厂只如实返回。
 *
 * zod 经本模块运行时 import——zod 是主包 peerDependency（业务方必装，zod.js 产物
 * 亦由它创建），解析器与 zod.js 产物共享同一 zod 实例。
 *
 * @param options.rootDir 项目根目录（缺省 `process.cwd()`）
 * @param options.dist 产物目录（可选；缺省走 dev on demand / `FAAPI_DIST` 全局解析——
 *        与生产 dev/prod 一致。测试设施传显式 dist 指向临时产物目录，不触碰全局状态）
 */
export function createToolSchemaResolver(options?: { rootDir?: string; dist?: string }) {
  const rootDir = options?.rootDir ?? process.cwd();
  const dist = options?.dist;
  const schemaCache = new Map<
    string,
    { mtimeMs: number; resolution: Promise<ToolSchemaResolution | undefined> }
  >();
  return (ref: SchemaSourceRef): Promise<ToolSchemaResolution | undefined> => {
    const zodPath = getToolSchemaPath(ref, rootDir, dist);
    const key = `${zodPath}#${ref.inputTypeName ?? ''}`;
    let mtimeMs = -1;
    try {
      mtimeMs = statSync(zodPath).mtimeMs;
    } catch {
      // zod.js 不存在（无 inputTypeName / 尚未生成）→ mtimeMs 保持 -1
    }
    const hit = schemaCache.get(key);
    if (hit && hit.mtimeMs === mtimeMs) {
      return hit.resolution;
    }
    // in-flight Promise 直接缓存:同一来源的并发请求共享同一次解析
    const resolution = resolveToolSchemaImpl(ref, rootDir, dist);
    schemaCache.set(key, { mtimeMs, resolution });
    return resolution;
  };
}
