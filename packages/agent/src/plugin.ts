/**
 * @faapi/agent faapi 插件——注册 agent handle 工厂,让 handler 的 `agent` 参数注入可用的 Agent 实例
 *
 * 在 faapi.config.ts 中声明：
 * ```ts
 * import type { FaapiConfig } from '@faapi/faapi';
 *
 * export default {
 *   agent: {
 *     llms: {
 *       openai: {
 *         provider: 'openai',
 *         apiKey: process.env.OPENAI_API_KEY,
 *         baseURL: 'https://api.openai.com/v1',
 *         models: { 'gpt-4o': {}, 'gpt-4o-mini': { temperature: 0.5 } },
 *       },
 *     },
 *     defaultLlm: 'openai',
 *     defaultAgent: 'researcher',
 *     maxTurns: 10,
 *   },
 *   plugins: ['@faapi/agent'],
 * } satisfies FaapiConfig;
 * ```
 *
 * 插件 setup 时：
 * 1. 遍历 `config.agent.llms`（可选）→ 每项调 `createProvider` → `Map<providerKey, LLMProvider>`
 * 2. 读 `config.agent.defaultLlm` → `defaultProvider`（未设时用 `llms` 第一个 key;
 *    `llms` 未配置/未命中时为 `undefined`——外部 provider 模式,照常注册工厂）
 * 3. 读 `config.agent.defaultAgent`（可选） / `maxTurns` / `maxAgentDepth`
 * 4. 从 `@faapi/faapi` import 注册表/加载器访问器（getAgent / getTool / resolveAgentTools /
 *    resolveSubAgents / loadAgentModule / loadToolModule）
 * 5. `registerAgentHandleFactory` 注册工厂——每次请求时构造 [Agent](./agent.md) 实例注入到
 *    handler 的 `agent` 参数
 *
 * `agent.llms` 可选——未配置时工厂照常注册（外部 provider 模式）,`agent.run/stream`
 * 需调用方传 `options.provider` 才能调用 LLM。只有插件未加载时 `agent` 参数才注入 `undefined`。
 *
 * `defaultAgent` 可选——未设时 handler 需通过 `agent.run(input, { agent: 'name' })`
 * 显式指定 agent 名。
 *
 * 详见 [plugin.md](./plugin.md)。
 */

import {
  loadAgentModule,
  loadToolModule,
  loadToolSchema,
  getToolSchemaPath,
  type FaapiPlugin,
  type PluginContext,
  type AgentConfig,
  type ToolMetadata,
} from '@faapi/faapi';
import { statSync } from 'node:fs';
import { z } from 'zod';
import { Agent, type AgentRuntimeConfig, type ToolSchemaResolution } from './agent';
import type { LLMProvider } from './provider';
import { createProvider } from './provider';

/**
 * 加载 tool 的 zod.js → 生成 JSON Schema + 校验函数
 *
 * 模块级函数（非 setup 内闭包）——setup 时用 `rootDir` 偏函数绑定一次,
 * 工厂内直接复用,避免每次请求重建闭包。
 *
 * 详见 [plugin.md](./plugin.md) 的 resolveToolSchema 实现。
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
 * 从 PluginContext.config 读取 agent 配置
 *
 * `agent` 不是 FAAPI_CONFIG_KEYS 的成员（它是 agent 子系统配置,非核心配置）,
 * 因此会随自定义业务配置一起传到 `ctx.config`。
 */
function readAgentConfig(ctx: PluginContext): AgentConfig | undefined {
  const raw = ctx.config?.agent;
  if (raw === undefined || raw === null) return undefined;
  return raw as AgentConfig;
}

/**
 * @faapi/agent faapi 插件入口
 *
 * 在 faapi.config.ts 的 `plugins` 字段中声明 `'@faapi/agent'` 即可启用。
 * 插件加载后,handler 的 `agent` 参数可注入可用的 [AgentHandle](./agentHandle.md)。
 */
const agentPlugin: FaapiPlugin = {
  name: '@faapi/agent',
  setup(ctx: PluginContext): void {
    // app 级注册表实例（每个 app 独立，随 app 生命周期）
    const registries = ctx.registries;
    const agentConfig = readAgentConfig(ctx);

    // llms 可选——未配置时进入「外部 provider 模式」：工厂照常注册（providers 为空 Map,
    // 无默认 provider）,agent.run/stream 需调用方传 options.provider 才能调用 LLM
    const llms = agentConfig?.llms ?? {};
    if (Object.keys(llms).length === 0) {
      console.log(
        '- @faapi/agent: no llms configured — use agent.run(input, { provider }) to pass an external provider per call',
      );
    }

    // defaultAgent 可选——未设时 handler 需通过 agent.run(input, { agent: 'name' }) 显式指定
    const defaultAgent = agentConfig?.defaultAgent ?? '';

    // 创建 LLM provider 实例 Map（key 是 provider 名,来自 config.agent.llms）
    // 单例,所有请求共享;每个 provider 实例对应一个 LlmConfig
    const providers = new Map<string, LLMProvider>();
    for (const [name, llmConfig] of Object.entries(llms)) {
      // 空 apiKey 照常注册（部分网关/本地模型场景无需 key），但启动日志显性提示——
      // 否则「key 未配置」延迟到首次 LLM 调用才暴露为上游 401，且错误文案来自上游，难排查
      if (!llmConfig.apiKey || llmConfig.apiKey.trim() === '') {
        console.warn(
          `! @faapi/agent: config.agent.llms.${name}.apiKey is empty, requests to this provider will omit Authorization header (upstream likely returns 401)`,
        );
      }
      providers.set(name, createProvider(llmConfig));
    }

    // 默认 provider：config.agent.defaultLlm 优先,否则取 llms 第一个 key;
    // llms 未配置 / defaultLlm 未命中时为 undefined（外部 provider 模式,照常注册）
    const defaultLlm = agentConfig?.defaultLlm ?? Object.keys(llms)[0];
    const defaultProvider = defaultLlm !== undefined ? providers.get(defaultLlm) : undefined;
    if (defaultLlm !== undefined && !defaultProvider) {
      console.warn(
        `! @faapi/agent: config.agent.defaultLlm "${defaultLlm}" not found in llms — no default provider, use agent.run(input, { provider }) to pass an external provider per call`,
      );
    }

    // 全局 agent 运行时配置覆盖
    const runtimeConfig: AgentRuntimeConfig = {
      maxTurns: agentConfig?.maxTurns,
      maxAgentDepth: agentConfig?.maxAgentDepth,
      maxHistoryTokens: agentConfig?.maxHistoryTokens,
      // 鉴权钩子（authHooks,见 ./authHooks.md）——业务方在 config.agent 声明
      beforeToolCall: agentConfig?.beforeToolCall,
      afterToolCall: agentConfig?.afterToolCall,
      filterTools: agentConfig?.filterTools,
    };

    const rootDir = ctx.rootDir;
    // 跨请求 schema 缓存（setup 闭包级,工厂每次请求 new Agent 但共享此缓存）
    //
    // Agent 工厂每请求构造新实例,实例级 schemaCache（agent.ts）随实例丢弃——
    // 若无此缓存,每个请求都要重新 loadToolSchema（dynamic import + existsSync）+
    // z.toJSONSchema（CPU 密集）。缓存键为 `zodPath#inputTypeName`,值携带 zod.js 的
    // mtime：每次查找 statSync 一次（与原 loadToolSchema 内部的 existsSync 同级开销,
    // 非新增 IO）,mtime 变化即重新解析——dev reloadTools 重生成 zod.js 后自愈,
    // prod 产物固化下永远命中,无需 faapi 核心 reload 链路通知本插件。
    const schemaCache = new Map<
      string,
      { mtimeMs: number; resolution: Promise<ToolSchemaResolution | undefined> }
    >();
    const resolveToolSchema = (tool: ToolMetadata): Promise<ToolSchemaResolution | undefined> => {
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

    // 注册 agent handle 工厂——每次请求时构造 Agent 实例
    // Agent 构造轻量（仅存 deps）,实际 LLM 调用在 run/stream 时才发生
    // 方案 A：注册到 **app 实例**的 agentHandle store（ctx.registries），
    // 多 app 同进程互不覆盖；deps 读同套实例注册表（createAppBase 已水合）
    ctx.registries.agentHandle.register((ctx) => {
      return new Agent({
        providers,
        defaultProvider,
        llms,
        defaultLlm,
        agentName: defaultAgent ?? '',
        rootDir,
        config: runtimeConfig,
        // ctx 传递链（authHooks）：捕获请求上下文,tool handler / sub-agent /
        // 鉴权钩子均可读取中间件塞入的身份信息（ctx.user / ctx.workspace 等）
        ctx,
        // 注册表访问器——app 实例（PluginContext.registries），非全局单例
        // getAgent 返回 AgentCore(LLM-facing);getAgentEntry 返回 AgentMetadata(含 filePath/hasRun,供加载 handler.js)
        getAgent: registries.agent.getAgent,
        getAgentEntry: registries.agent.getAgentEntry,
        getTool: registries.tool.get,
        resolveAgentTools: registries.agent.resolveAgentTools,
        resolveSubAgents: registries.agent.resolveSubAgents,
        // 加载器包装：注入 rootDir 用于 dev 按需编译模式
        loadToolModule: (filePath, functionName) => loadToolModule(filePath, functionName, rootDir),
        loadAgentModule: (filePath, hasRun) => loadAgentModule(filePath, hasRun, rootDir),
        // tool schema 解析（zod.js → JSON Schema + safeParse 校验）
        resolveToolSchema,
      });
    });

    console.log(
      defaultProvider
        ? defaultAgent
          ? `- @faapi/agent: default agent "${defaultAgent}" (provider: ${defaultLlm}) available via agent parameter injection`
          : `- @faapi/agent: no defaultAgent set — use agent.run(input, { agent: 'name' }) to specify agent (provider: ${defaultLlm})`
        : '- @faapi/agent: no default provider — use agent.run(input, { provider }) to pass an external provider per call',
    );
  },
};

export default agentPlugin;
