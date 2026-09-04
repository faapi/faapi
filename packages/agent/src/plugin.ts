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
 * 1. 遍历 `config.agent.llms` → 每项调 `createProvider` → `Map<providerKey, LLMProvider>`
 * 2. 读 `config.agent.defaultLlm` → `defaultProvider`（未设时用 `llms` 第一个 key）
 * 3. 读 `config.agent.defaultAgent`（可选） / `maxTurns` / `maxAgentDepth`
 * 4. 从 `@faapi/faapi` import 注册表/加载器访问器（getAgent / getTool / resolveAgentTools /
 *    resolveSubAgents / loadAgentModule / loadToolModule）
 * 5. `registerAgentHandleFactory` 注册工厂——每次请求时构造 [Agent](./agent.md) 实例注入到
 *    handler 的 `agent` 参数
 *
 * 配置缺失时（`agent.llms` 未设置）跳过工厂注册并打印警告,
 * handler 的 `agent` 参数注入 `undefined`。
 *
 * `defaultAgent` 可选——未设时 handler 需通过 `agent.run(input, { agent: 'name' })`
 * 显式指定 agent 名。
 *
 * 详见 [plugin.md](./plugin.md)。
 */

import {
  registerAgentHandleFactory,
  getAgent,
  getAgentEntry,
  getTool,
  resolveAgentTools,
  resolveSubAgents,
  loadAgentModule,
  loadToolModule,
  loadToolSchema,
  type FaapiPlugin,
  type PluginContext,
  type AgentConfig,
  type ToolMetadata,
} from '@faapi/faapi';
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
    const agentConfig = readAgentConfig(ctx);
    // 必要配置检查——llms 缺失时跳过工厂注册,agent 参数注入 undefined
    if (!agentConfig?.llms) {
      console.warn(
        '! @faapi/agent: config.agent.llms not configured, agent parameter injection disabled',
      );
      return;
    }

    // defaultAgent 可选——未设时 handler 需通过 agent.run(input, { agent: 'name' }) 显式指定
    const defaultAgent = agentConfig.defaultAgent ?? '';

    // 创建 LLM provider 实例 Map（key 是 provider 名,来自 config.agent.llms）
    // 单例,所有请求共享;每个 provider 实例对应一个 LlmConfig
    const llms = agentConfig.llms;
    const providers = new Map<string, LLMProvider>();
    for (const [name, llmConfig] of Object.entries(llms)) {
      providers.set(name, createProvider(llmConfig));
    }

    // 默认 provider：config.agent.defaultLlm 优先,否则取 llms 第一个 key
    const defaultLlm = agentConfig.defaultLlm ?? Object.keys(llms)[0];
    const defaultProvider = providers.get(defaultLlm);
    if (!defaultProvider) {
      console.warn(
        `! @faapi/agent: config.agent.defaultLlm "${defaultLlm}" not found in llms, agent parameter injection disabled`,
      );
      return;
    }

    // 全局 agent 运行时配置覆盖
    const runtimeConfig: AgentRuntimeConfig = {
      maxTurns: agentConfig.maxTurns,
      maxAgentDepth: agentConfig.maxAgentDepth,
    };

    const rootDir = ctx.rootDir;
    // resolveToolSchema 偏函数（setup 内创建一次，工厂内复用，避免每次请求重建闭包）
    const resolveToolSchema = (tool: ToolMetadata) => resolveToolSchemaImpl(tool, rootDir);

    // 注册 agent handle 工厂——每次请求时构造 Agent 实例
    // Agent 构造轻量（仅存 deps）,实际 LLM 调用在 run/stream 时才发生
    registerAgentHandleFactory(() => {
      return new Agent({
        providers,
        defaultProvider,
        llms,
        defaultLlm,
        agentName: defaultAgent,
        rootDir,
        config: runtimeConfig,
        // 注册表/加载器访问器——从 @faapi/faapi import 的单例模块
        // createAppBase 启动时已水合 agentRegistry / toolRegistry
        // getAgent 返回 AgentCore(LLM-facing);getAgentEntry 返回 AgentMetadata(含 filePath/hasRun,供加载 handler.js)
        getAgent,
        getAgentEntry,
        getTool,
        resolveAgentTools,
        resolveSubAgents,
        // 加载器包装：注入 rootDir 用于 dev 按需编译模式
        loadToolModule: (filePath, functionName) => loadToolModule(filePath, functionName, rootDir),
        loadAgentModule: (filePath, hasRun) => loadAgentModule(filePath, hasRun, rootDir),
        // tool schema 解析（zod.js → JSON Schema + safeParse 校验）
        resolveToolSchema,
      });
    });

    console.log(
      defaultAgent
        ? `- @faapi/agent: default agent "${defaultAgent}" (provider: ${defaultLlm}) available via agent parameter injection`
        : `- @faapi/agent: no defaultAgent set — use agent.run(input, { agent: 'name' }) to specify agent (provider: ${defaultLlm})`,
    );
  },
};

export default agentPlugin;
