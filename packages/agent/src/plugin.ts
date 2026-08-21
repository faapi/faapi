/**
 * @faapi/agent faapi 插件——注册 agent handle 工厂,让 handler 的 `agent` 参数注入可用的 Agent 实例
 *
 * 在 faapi.config.ts 中声明：
 * ```ts
 * import type { FaapiConfig } from '@faapi/faapi';
 *
 * export default {
 *   agent: {
 *     llm: { provider: 'openai', apiKey: process.env.OPENAI_API_KEY, model: 'gpt-4o' },
 *     defaultAgent: 'researcher',
 *     maxTurns: 10,
 *   },
 *   plugins: ['@faapi/agent'],
 * } satisfies FaapiConfig;
 * ```
 *
 * 插件 setup 时：
 * 1. 读 `config.agent.llm` → `createProvider` → LLMProvider 实例（单例）
 * 2. 读 `config.agent.defaultAgent` / `maxTurns` / `maxAgentDepth` / `defaultTools`
 * 3. 从 `@faapi/faapi` import 注册表/加载器访问器（getAgent / getTool / resolveAgentTools /
 *    resolveSubAgents / loadAgentModule / loadToolModule）
 * 4. `registerAgentHandleFactory` 注册工厂——每次请求时构造 [Agent](./agent.md) 实例注入到
 *    handler 的 `agent` 参数
 *
 * 配置缺失时（`agent.llm` 或 `agent.defaultAgent` 未设置）跳过工厂注册并打印警告,
 * handler 的 `agent` 参数注入 `undefined`。
 *
 * 详见 [plugin.md](./plugin.md)。
 */

import {
  registerAgentHandleFactory,
  getAgent,
  getTool,
  resolveAgentTools,
  resolveSubAgents,
  loadAgentModule,
  loadToolModule,
  loadToolSchema,
  type FaapiPlugin,
  type PluginContext,
  type AgentConfig,
} from '@faapi/faapi';
import { z } from 'zod';
import { Agent, type AgentRuntimeConfig, type ToolSchemaResolution } from './agent';
import { createProvider } from './provider';

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

    // 必要配置检查——缺失时跳过工厂注册,agent 参数注入 undefined
    if (!agentConfig?.llm) {
      console.warn(
        '! @faapi/agent: config.agent.llm not configured, agent parameter injection disabled',
      );
      return;
    }
    if (!agentConfig.defaultAgent) {
      console.warn(
        '! @faapi/agent: config.agent.defaultAgent not configured, agent parameter injection disabled',
      );
      return;
    }

    // 创建 LLM provider（单例,所有请求共享）
    const provider = createProvider(agentConfig.llm);

    // 全局 agent 运行时配置覆盖
    const runtimeConfig: AgentRuntimeConfig = {
      maxTurns: agentConfig.maxTurns,
      maxAgentDepth: agentConfig.maxAgentDepth,
      defaultTools: agentConfig.defaultTools,
    };

    const rootDir = ctx.rootDir;
    const defaultAgent = agentConfig.defaultAgent;

    // 注册 agent handle 工厂——每次请求时构造 Agent 实例
    // Agent 构造轻量（仅存 deps）,实际 LLM 调用在 run/stream 时才发生
    registerAgentHandleFactory(() => {
      return new Agent({
        provider,
        agentName: defaultAgent,
        rootDir,
        config: runtimeConfig,
        // 注册表/加载器访问器——从 @faapi/faapi import 的单例模块
        // createAppBase 启动时已水合 agentRegistry / toolRegistry
        getAgent,
        getTool,
        resolveAgentTools,
        resolveSubAgents,
        // 加载器包装：注入 rootDir 用于 dev 按需编译模式
        loadToolModule: (filePath, functionName) => loadToolModule(filePath, functionName, rootDir),
        loadAgentModule: (filePath, hasConfig, hasRun) =>
          loadAgentModule(filePath, hasConfig, hasRun, rootDir),
        // resolveToolSchema：加载 tool 的 zod.js → z.toJSONSchema 生成 JSON Schema 发给 LLM
        // + safeParse 校验 LLM 返回的参数（失败回传 LLM 重试，不调 handler）
        resolveToolSchema: async (tool) => {
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
        },
      });
    });

    console.log(
      `- @faapi/agent: default agent "${defaultAgent}" available via agent parameter injection`,
    );
  },
};

export default agentPlugin;
