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
  AgentAbortError,
  LLMProviderError,
  LLMTimeoutError,
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

// 轻量 LLM 补全通道（agent 循环之外的一次性补全出口，详见 lightComplete.md）
export { createLightComplete } from './lightComplete';
// 脚本假 LLM（agent 流程测试的确定性 provider，详见 scriptLlm.md）
export { createScriptLLM, type ScriptTurn, type ScriptedLLM } from './scriptLlm';

// AgentDeps 装配工厂（插件 setup / 任务内组装 / 自组装单一实现，详见 agentDeps.md）
export {
  createAgentDeps,
  type CreateAgentDepsOptions,
  type AgentDepsRegistries,
} from './agentDeps';
// 规范类型主包持有（TaskContext 等主包类型引用），此处 re-export 供业务方统一标注
export type { LlmComplete, LlmCompleteOptions } from '@faapi/faapi';

// ReAct 循环引擎（Phase 3.3）
export {
  reactLoop,
  reactLoopStream,
  ReactLoopError,
  isSubAgentToolResult,
  type ToolExecutor,
  type ReactLoopConfig,
  type ReactLoopResult,
  type ReactLoopStreamChunk,
  type SubAgentDelta,
  type SubAgentDeltaEmitter,
  type SubAgentToolResult,
} from './reactLoop';

// 历史压缩：策略位（historyCompactor）+ 输出不变量守卫（详见 historyCompaction.md）
export type { HistoryCompactor, HistoryCompactorInput } from './historyCompaction';

// 历史压缩：滚动摘要现货组件（可选用,配方参数全可覆盖,详见 rollingSummary.md）
export {
  createRollingSummaryCompactor,
  type RollingSummaryOptions,
  type RollingSummaryCompactor,
  type FoldPlan,
  type SummaryComplete,
} from './rollingSummary';

// Tracing 类型（结构化调用明细,Phase 3.x）——单次 agent.run() 的明细 + sub-agent 嵌套 trace
export {
  isTracingToolResult,
  type AgentTrace,
  type AgentTraceEvent,
  type LlmCallEvent,
  type ToolCallEvent,
  type SubAgentCallEvent,
  type TracingToolResult,
} from './trace';

// Agent 类（Phase 3.4）——组装 reactLoop config + 执行 tool + 递归 sub-agent
export {
  Agent,
  AgentError,
  AgentRecursionError,
  AgentToolTimeoutError,
  type AgentDeps,
  type AgentRuntimeConfig,
  type ToolSchemaResolution,
} from './agent';

// schema 解析工厂——任务内组装 AgentDeps.resolveToolSchema / resolveAgentInputSchema 的官方入口
// （同一实例服务 tool input 与 sub-agent 派发入参,参数为最小结构 SchemaSourceRef）。
// 实现下沉主包 loader 域（zod peer 同源 + 测试设施 createAgentTestHarness 共用）,
// 此处 re-export 保持 `from '@faapi/agent'` 导入路径不变
export { createToolSchemaResolver, type SchemaSourceRef } from '@faapi/faapi';

// AgentHandle 接口 + AgentRunOptions（Phase 3.5）——handler 的 agent 参数类型,Agent 满足此接口
export { type AgentHandle, type AgentRunOptions } from './agentHandle';

// 默认导出：faapi 插件（Phase 3.5）——在 faapi.config.ts 的 plugins 中声明 '@faapi/agent' 即启用
export { default } from './plugin';
