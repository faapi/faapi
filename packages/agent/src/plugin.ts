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
 *     maxTurns: 10,
 *   },
 *   plugins: ['@faapi/agent'],
 * } satisfies FaapiConfig;
 * ```
 *
 * 插件 setup 时：
 * 1. `createAgentDeps` 装配 deps（llms 可选 → 逐项 createProvider → providers Map）
 * 2. 读 `config.agent.maxTurns` / `maxAgentDepth`
 * 3. 从 `@faapi/faapi` import 注册表/加载器访问器（getAgent / getTool / resolveAgentTools /
 *    resolveSubAgents / loadToolModule）,tool schema 解析用
 *    [createToolSchemaResolver](./toolSchemaResolver.md)（setup 闭包级缓存）
 * 4. `registerAgentHandleFactory` 注册工厂——每次请求时构造 [Agent](./agent.md) 实例注入到
 *    handler 的 `agent` 参数
 *
 * 无默认 agent / 默认 provider——`agent.run/stream` 每次调用显式传 `options.agent` +
 * `options.model` / `options.provider`。
 *
 * `agent.llms` 可选——未配置时工厂照常注册（外部 provider 模式）,`agent.run/stream`
 * 需调用方传 `options.provider` 才能调用 LLM。只有插件未加载时 `agent` 参数才注入 `undefined`。
 *
 * 详见 [plugin.md](./plugin.md)。
 */

import { type FaapiPlugin, type PluginContext, type AgentConfig } from '@faapi/faapi';
import { Agent, AgentError, extractSubAgentUserInput } from './agent';
import type { AgentRunOptions } from './agentHandle';
import { createAgentDeps } from './agentDeps';
import { createLightComplete } from './lightComplete';
import { createStandaloneToolContext } from './standaloneToolContext';

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

    // llms 可选——未配置时进入「外部 provider 模式」：工厂照常注册（providers 为空 Map）,
    // agent.run/stream 需调用方传 options.provider 才能调用 LLM
    const llms = agentConfig?.llms ?? {};
    if (Object.keys(llms).length === 0) {
      console.log(
        '- @faapi/agent: no llms configured — use agent.run(input, { agent, provider }) to pass an external provider per call',
      );
    }

    // 空 apiKey 照常注册（部分网关/本地模型场景无需 key），但启动日志显性提示——
    // 否则「key 未配置」延迟到首次 LLM 调用才暴露为上游 401，且错误文案来自上游，难排查。
    // （providers 实例由下方 createAgentDeps 创建，此处只做配置检查）
    for (const [name, llmConfig] of Object.entries(llms)) {
      if (!llmConfig.apiKey || llmConfig.apiKey.trim() === '') {
        console.warn(
          `! @faapi/agent: config.agent.llms.${name}.apiKey is empty, requests to this provider will omit Authorization header (upstream likely returns 401)`,
        );
      }
    }

    // 全局 agent 运行时配置经 agentConfig 复合块整体透传（拆装清单在
    // createAgentDeps 的 toAgentRuntimeConfig 单一维护——新增旋钮两路自动到达）。
    // overrides 注入 app 事件发射器（appEventBus——agent:root-input / agent:input
    // 接缝的发射源,业务方经 getApp().on 订阅;app 实例注册表,close 随实例清理）
    const rootDir = ctx.rootDir;
    const baseDeps = createAgentDeps({
      registries,
      rootDir,
      agentConfig: agentConfig ?? {},
      // ctx 必填契约下的 baseDeps 占位：工厂每次请求以请求 ctx 覆盖（下方 register），
      // 占位 ctx 不会被任何 tool 调用消费——缺省桩的诚实性由 standaloneToolContext 保证
      ctx: createStandaloneToolContext(),
      overrides: { emitAppEvent: registries.appEvents.emit },
    });

    // 轻量补全通道注册到 registries.llm——handler 的 `llm` 注入参数与任务执行上下文
    // （taskCtx.llm，进程内路径）读取；与 agent 循环共享同一 providers 单例
    // （llms 未配置时通道照常注册，调用时报 AgentError 提示配置缺失）
    ctx.registries.llm.register(createLightComplete({ llms, providers: baseDeps.providers }));

    // 注册 agent handle 工厂——每次请求时构造 Agent 实例
    // Agent 构造轻量（仅存 deps）,实际 LLM 调用在 run/stream 时才发生
    // 方案 A：注册到 **app 实例**的 agentHandle store（ctx.registries），
    // 多 app 同进程互不覆盖；deps 读同套实例注册表（createAppBase 已水合）
    // systemPromptFile 读取走主包免传参 readResource（读取根 app 启动时已绑定）
    ctx.registries.agentHandle.register((ctx) => {
      return new Agent({ ...baseDeps, ctx });
    });

    // 注册 agent 循环执行器——隔离 worker 调 agent 收敛为单次 agent-run RPC：
    // worker 侧 taskCtx.agent.run 转发请求，宿主在此以任务合成契约 ctx 构造 Agent
    // 跑完整编排循环（LLM IO、tool 执行、钩子、sub-agent 全在宿主——
    // db 连接池等资源单实例、业务函数零跨线程）。插件未加载时 runner store 为空
    // ——worker 内 taskCtx.agent 不挂载（能力不存在非降级，见 taskTypes.md）
    ctx.registries.agentRunner.register({
      runAgent: async (ctx, request, execution) => {
        const { agentName, options } = request;
        const entry = baseDeps.getAgentEntry(agentName);
        // 派发入参校验（富 schema 派发形态——镜像 executeSubAgent：声明 Input 且
        // resolver 已接线时校验，失败/产物缺失显式抛错，RPC ok:false 原样回传
        // worker 以任务错误浮出）。字符串入参为 user 消息直传（与 HTTP/编程式
        // run 同语义，不经派发 schema）；结构化对象为派发形态，宿主跑循环前校验
        let runInput: string | undefined;
        if (typeof request.input === 'object' && request.input !== null) {
          if (entry?.inputTypeName && baseDeps.resolveAgentInputSchema) {
            const schemaRes = await baseDeps.resolveAgentInputSchema(entry);
            if (!schemaRes) {
              throw new AgentError(
                `Agent "${agentName}" declares input schema "${entry.inputTypeName}" but its zod.js artifact is missing or broken (run \`faapi build\` / restart \`faapi dev\` to regenerate)`,
              );
            }
            const result = schemaRes.validate(request.input);
            if (!result.ok) {
              throw new AgentError(`Agent "${agentName}" input validation failed: ${result.error}`);
            }
          }
          runInput = extractSubAgentUserInput(request.input);
        } else {
          runInput = request.input;
        }
        // 完整循环：与 HTTP 请求链同一份 baseDeps（工具/钩子单一实现）
        const agent = new Agent({ ...baseDeps, ctx });
        return agent.run(runInput, {
          ...(options as AgentRunOptions | undefined),
          agent: agentName,
          // 宿主任务取消传播 agent 循环（宿主侧优先）：隔离任务两段式取消第一段
          // abort 此 signal——ReactLoop 每轮预检查 + provider 请求中断抛
          // AgentAbortError（messages 由宿主留痕 agent-aborted 事件，可续跑）
          signal: execution?.signal ?? (options as AgentRunOptions | undefined)?.signal,
        });
      },
    });

    console.log(
      Object.keys(llms).length > 0
        ? `- @faapi/agent: providers [${Object.keys(llms).join(', ')}] — call agent.run(input, { agent, model }) to execute (no default agent/provider)`
        : '- @faapi/agent: no llms configured — use agent.run(input, { agent, provider }) to pass an external provider per call',
    );
  },
};

export default agentPlugin;
