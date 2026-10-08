/**
 * tool schema 解析工厂——把 tool 的 zod.js 解析为 AgentDeps.resolveToolSchema 契约值
 *
 * `AgentDeps.resolveToolSchema` 要求返回 [ToolSchemaResolution](./agent.md)
 * （`{ jsonSchema, validate }`），而 faapi 核心公开导出的
 * [loadToolSchema](../../faapi/src/loader/loadToolSchema.md) 返回的是
 * `{ schema, schemaName }` 原始 zod 模块——两者之间的装配（`z.toJSONSchema`
 * + `safeParse`）集中在本模块，经 `createToolSchemaResolver` 公开导出，
 * 插件 setup 与任务内组装 agent 共用同一实现，业务方无需镜像框架内部逻辑。
 *
 * 详见 [toolSchemaResolver.md](./toolSchemaResolver.md)。
 */

import { statSync } from 'node:fs';
import { z } from 'zod';
import { loadToolSchema, getToolSchemaPath } from '@faapi/faapi';
import type { ToolSchemaResolution } from './agent';

/**
 * schema 定位的最小来源结构——tool 元数据（`ToolMetadata`）与 agent 完整元数据
 * （`AgentMetadata`，派发入参 schema 声明场景）均满足，同一 resolver 服务两类来源
 * （`AgentDeps.resolveToolSchema` + `AgentDeps.resolveAgentInputSchema`），缓存按
 * zod.js 路径天然分流
 */
export type SchemaSourceRef = {
  filePath: string;
  inputTypeName?: string;
};

/**
 * 单次解析（无缓存）——loadToolSchema 加载 zod.js → 生成 JSON Schema + 校验函数
 *
 * @param ref schema 来源元数据（tool / agent 均可，含 filePath / inputTypeName）
 * @param rootDir 项目根目录（用于 dev 按需编译模式）
 * @returns `ToolSchemaResolution` 或 `undefined`（zod.js 不存在 / 无 inputTypeName）
 */
async function resolveToolSchemaImpl(
  ref: SchemaSourceRef,
  rootDir: string,
): Promise<ToolSchemaResolution | undefined> {
  const schemaMod = await loadToolSchema(ref, rootDir);
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
 * 返回的函数满足 `AgentDeps.resolveToolSchema` / `AgentDeps.resolveAgentInputSchema`
 * 两个签名（参数为最小结构 `SchemaSourceRef`），供三处共用：
 * - `@faapi/agent` 插件 setup（传 `ctx.rootDir`，同一实例注入两个 deps，root +
 *   sub-agent 共享同一闭包缓存）
 * - 任务内组装 [Agent](./agent.md)（`TaskContext` 无 rootDir，缺省 `process.cwd()`——
 *   faapi 服务进程 cwd 即项目根；建议任务文件模块级创建一次）
 *
 * **缓存语义**（闭包级 `Map<key, { mtimeMs, resolution }>`）：
 * - 缓存键 `zodPath#inputTypeName`，每次查找 `statSync` 一次做 mtime 自校验——
 *   mtime 变化即重新解析（dev reload 重生成 zod.js 后自愈，prod 产物固化永远命中）
 * - in-flight Promise 直接入缓存：同一来源的并发调用共享同一次解析
 * - 每次 `createToolSchemaResolver` 调用返回独立缓存的 resolver
 *
 * zod.js 缺失 / 无 `inputTypeName` 时解析结果为 `undefined`——tool 侧用自由 schema
 * `{ type: 'object' }`；agent 派发侧对「声明了 `inputTypeName` 但解析为 `undefined`」
 * 的产物异常语义（显式抛错）由 [agent.ts](./agent.ts) 定义，本工厂只如实返回。
 *
 * @param options.rootDir 项目根目录（缺省 `process.cwd()`）
 */
export function createToolSchemaResolver(options?: { rootDir?: string }) {
  const rootDir = options?.rootDir ?? process.cwd();
  const schemaCache = new Map<
    string,
    { mtimeMs: number; resolution: Promise<ToolSchemaResolution | undefined> }
  >();
  return (ref: SchemaSourceRef): Promise<ToolSchemaResolution | undefined> => {
    const zodPath = getToolSchemaPath(ref, rootDir);
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
    const resolution = resolveToolSchemaImpl(ref, rootDir);
    schemaCache.set(key, { mtimeMs, resolution });
    return resolution;
  };
}
