/**
 * @faapi/agent — Agent runtime for faapi
 *
 * 在 faapi 已扫描的 agent / tool 注册表（faapi-agents.js + faapi-tools.js）
 * 之上提供 LLM 驱动的 ReAct 循环、tool calling、sub-agent 递归与流式输出。
 *
 * 与 faapi 核心的关系：
 * - 核心包负责扫描 agent handler.ts（src/agents/<name>/handler.ts）与 tool handler.ts
 *   （src/tools/ 与 src/agents/<name>/tools/ 下），生成 faapi-agents.js + faapi-tools.js
 *   清单并水合到 agentRegistry / toolRegistry
 * - 本包负责运行时：Agent 类按 agent.name 查找元数据，调 loadAgentModule 加载 handler，
 *   通过 reactLoop 调用 LLM provider → 发送 tool 列表 → 执行 tool / 递归 sub-agent → 流式输出
 *
 * Phase 3.1：包骨架初始化（按 AGENTS.md 6.5 清单配置）
 * Phase 3.2：LLMProvider 抽象 + OpenAI 兼容 provider 实现
 * Phase 3.3：ReAct 循环引擎（reactLoop + reactLoopStream）
 * Phase 3.4：Agent 类（run / stream / asTool）
 * Phase 3.5：与 faapi 核心 agent 注入器集成（AgentHandle + plugin + 工厂注册）
 * 后续阶段：
 * - Phase 3.6：fixtures 跑通多 agent demo
 */

// LLM Provider 抽象与工厂（Phase 3.2）
export {
  createProvider,
  LLMProviderError,
  type LLMProvider,
  type LLMMessage,
  type LLMToolCall,
  type LLMToolDefinition,
  type LLMCompleteRequest,
  type LLMResponse,
  type LLMStopReason,
  type LLMStreamChunk,
  type LLMUsage,
} from './provider';

// OpenAI 兼容 provider 实现（Phase 3.2）
export { createOpenAIProvider } from './providers/openai';

// ReAct 循环引擎（Phase 3.3）
export {
  reactLoop,
  reactLoopStream,
  ReactLoopError,
  type ToolExecutor,
  type ReactLoopConfig,
  type ReactLoopResult,
  type ReactLoopStreamChunk,
} from './reactLoop';

// Agent 类（Phase 3.4）——组装 reactLoop config + 执行 tool + 递归 sub-agent
export {
  Agent,
  AgentError,
  AgentRecursionError,
  type AgentDeps,
  type AgentRuntimeConfig,
  type ToolSchemaResolution,
} from './agent';

// AgentHandle 接口（Phase 3.5）——handler 的 agent 参数类型,Agent 满足此接口
export { type AgentHandle } from './agentHandle';

// 默认导出：faapi 插件（Phase 3.5）——在 faapi.config.ts 的 plugins 中声明 '@faapi/agent' 即启用
export { default } from './plugin';
