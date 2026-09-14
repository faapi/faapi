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
import { loadToolSchema, getToolSchemaPath, type ToolMetadata } from '@faapi/faapi';
import type { ToolSchemaResolution } from './agent';

/**
 * 单次解析（无缓存）——loadToolSchema 加载 zod.js → 生成 JSON Schema + 校验函数
 *
 * @param tool tool 元数据（含 filePath / inputTypeName）
 * @param rootDir 项目根目录（用于 dev 按需编译模式）
 * @returns `ToolSchemaResolution` 或 `undefined`（zod.js 不存在 / tool 无 inputTypeName）
 */
async function resolveToolSchemaImpl(
  tool: ToolMetadata,
  rootDir: string,
): Promise<ToolSchemaResolution | undefined> {
  const schemaMod = await loadToolSchema(tool, rootDir);
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
 * 创建带 mtime 缓存的 tool schema 解析器
 *
 * 返回的函数满足 `AgentDeps.resolveToolSchema` 签名，供两处共用：
 * - `@faapi/agent` 插件 setup（传 `ctx.rootDir`，root + sub-agent 共享同一闭包缓存）
 * - 任务内组装 [Agent](./agent.md)（`TaskContext` 无 rootDir，缺省 `process.cwd()`——
 *   faapi 服务进程 cwd 即项目根；建议任务文件模块级创建一次）
 *
 * **缓存语义**（闭包级 `Map<key, { mtimeMs, resolution }>`）：
 * - 缓存键 `zodPath#inputTypeName`，每次查找 `statSync` 一次做 mtime 自校验——
 *   mtime 变化即重新解析（dev reloadTools 重生成 zod.js 后自愈，prod 产物固化永远命中）
 * - in-flight Promise 直接入缓存：同一 tool 的并发调用共享同一次解析
 * - 每次 `createToolSchemaResolver` 调用返回独立缓存的 resolver
 *
 * zod.js 缺失 / tool 无 `inputTypeName` 时解析结果为 `undefined`——agent 用
 * 自由 schema `{ type: 'object' }`，LLM 自由传参。
 *
 * @param options.rootDir 项目根目录（缺省 `process.cwd()`）
 */
export function createToolSchemaResolver(options?: { rootDir?: string }) {
  const rootDir = options?.rootDir ?? process.cwd();
  const schemaCache = new Map<
    string,
    { mtimeMs: number; resolution: Promise<ToolSchemaResolution | undefined> }
  >();
  return (tool: ToolMetadata): Promise<ToolSchemaResolution | undefined> => {
    const zodPath = getToolSchemaPath(tool, rootDir);
    const key = `${zodPath}#${tool.inputTypeName ?? ''}`;
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
    // in-flight Promise 直接缓存:同一 tool 的并发请求共享同一次解析
    const resolution = resolveToolSchemaImpl(tool, rootDir);
    schemaCache.set(key, { mtimeMs, resolution });
    return resolution;
  };
}
