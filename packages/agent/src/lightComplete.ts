import type { LlmConfig } from '@faapi/faapi';
import type { LlmComplete, LlmCompleteOptions } from '@faapi/faapi';
import { resolveModelKey } from './agent';
import { AgentAbortError, LLMProviderError } from './provider';
import type { LLMProvider } from './provider';
import { createProvider } from './provider';

/**
 * 轻量 LLM 补全通道——agent 工具循环之外的一次性补全官方出口
 *
 * 字符串进字符串出，复用 `agent.llms` 同源配置与 provider 重试引擎
 * （maxRetries / 指数退避 / Retry-After / 429·5xx 判定 / 超时），
 * 只统一传输机制，策略（重试次数、降级还是抛）留给调用方按场景声明。
 * 失败可降级不可静默：`fallback` 命中且未声明 `onFailure` 时框架 `console.warn` 兜底留痕。
 *
 * 接入点：
 * - handler `llm` 注入参数 / `taskCtx.llm`——由 [plugin](./plugin.md) 注册到 `registries.llm`
 * - 隔离任务 worker 内重建——`llms` 纯数据跨线程，worker 内调本工厂重建实例
 * - 编程式 / 测试——直接调本工厂
 *
 * 详见 [lightComplete.md](./lightComplete.md)。
 */

/** 轻量通道默认超时（毫秒）——options 与 LlmConfig 均未声明超时时的兜底 */
const DEFAULT_LIGHT_TIMEOUT_MS = 60_000;

/**
 * 创建轻量补全通道
 *
 * @param deps.llms provider 配置映射（来自 `config.agent.llms`，同源零新增配置）
 * @param deps.providers 已构建的 provider 实例映射（插件传入——与 agent 循环共享
 *                       同一单例）；缺省时按 `llms` 逐项 `createProvider` 现场构建
 *                       （隔离 worker 重建 / 测试形态）
 * @returns 补全通道（`complete` 方法）
 */
export function createLightComplete(deps: {
  llms: Record<string, LlmConfig>;
  providers?: Map<string, LLMProvider>;
}): LlmComplete {
  const llms = deps.llms;
  // providers 缺省时按 llms 构建（key 顺序 = llms 声明顺序，model 解析的默认 provider 由此确定）
  const providers = deps.providers ?? buildProviders(llms);

  return {
    async complete(input: string, options?: LlmCompleteOptions): Promise<string> {
      // 配置解析错误（编程/配置问题）早失败：不重试、不降级
      const defaultKey = Object.keys(llms)[0];
      const { provider, providerName, model } = resolveModelKey(
        options?.model,
        { providers, llms },
        defaultKey,
      );

      const messages = options?.system
        ? [
            { role: 'system' as const, content: options.system },
            { role: 'user' as const, content: input },
          ]
        : [{ role: 'user' as const, content: input }];

      // 超时优先级：options.timeoutMs > 目标 provider 的 LlmConfig.timeoutMs > 框架默认 60s
      // （request.timeoutMs 在 provider 层覆盖 config 级联，见 providers/openai.md）
      const llmConfig = llms[providerName];
      const configTimeout =
        typeof llmConfig?.timeoutMs === 'number' ? llmConfig.timeoutMs : undefined;
      const timeoutMs = options?.timeoutMs ?? configTimeout ?? DEFAULT_LIGHT_TIMEOUT_MS;

      try {
        const response = await provider.complete({
          messages,
          model,
          ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
          ...(options?.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
          ...(options?.signal !== undefined ? { signal: options.signal } : {}),
          timeoutMs,
          ...(options?.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
        });
        return response.message.content ?? '';
      } catch (err) {
        // 用户取消不是故障：不走 fallback、不触发钩子、不 warn（与 reactLoop 语义一致）
        if (err instanceof AgentAbortError) throw err;
        // 非 LLM 传输错误（provider 实现异常等）不属于本通道的失败语义，原样冒泡
        if (!(err instanceof LLMProviderError)) throw err;
        return handleFailure(err, options);
      }
    },
  };
}

/** 按 llms 配置逐项构建 provider 实例（createProvider 对未支持的 provider 名抛错） */
function buildProviders(llms: Record<string, LlmConfig>): Map<string, LLMProvider> {
  const providers = new Map<string, LLMProvider>();
  for (const [name, llmConfig] of Object.entries(llms)) {
    providers.set(name, createProvider(llmConfig));
  }
  return providers;
}

/**
 * 传输失败处理（重试耗尽后到达）：留痕 + 降级/抛出
 *
 * - `onFailure` 声明 → 调用（留痕点，自身抛错被忽略——副作用钩子不改变失败语义）
 * - `fallback` 声明 → 返回降级值；无 `onFailure` 时 `console.warn` 兜底（不可静默）
 * - 均未声明 → 原样抛出（调用方 try/catch 自主处理）
 */
function handleFailure(
  err: LLMProviderError,
  options: LlmCompleteOptions | undefined,
): Promise<string> {
  const { onFailure, fallback } = options ?? {};
  const attempts = err.attempts ?? 1;

  if (onFailure) {
    try {
      onFailure(err, { attempts });
    } catch {
      // 钩子是副作用，自身抛错被忽略（与 lifecycle.onError 同语义）
    }
  }

  if (fallback !== undefined) {
    if (!onFailure) {
      console.warn(
        `[faapi/agent] llm.complete fallback engaged after ${attempts} attempt(s): ${err.message}`,
      );
    }
    return Promise.resolve(fallback);
  }

  return Promise.reject(err);
}
