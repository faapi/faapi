/**
 * 命名白名单共用模块（agent / tool / task 三域同规则）
 *
 * agent（[scanAgents](../agents/scanAgents.md)）、tool（[scanTools](../tools/scanTools.md)）、
 * task（[scanTasks](../tasks/scanTasks.md)）的目录段白名单与 LLM 工具名字符集必须
 * 三域一致——本模块是唯一定义处，规则调整只改一处，「目录路径 → 注册名」映射的
 * 合法性口径不会分裂。
 */

/**
 * 目录段白名单——`_` 被 `/` 规范化独占为嵌套分隔符（段内出现会让「嵌套」与
 * 「段内下划线」不可区分，跨路径同名冲突检测失效），`.` 等其余字符一并拒绝。
 *
 * 白名单保证「目录路径 → 注册名」映射单射。agent / tool / task 三域共用此规则：
 * - agent 目录段（`src/agents/<path>/handler.ts`）
 * - tool 目录段（`src/tools/<path>/handler.ts`）
 * - task 目录段（`src/tasks/<path>/task.ts`）
 */
export const DIR_SEGMENT_PATTERN = /^[a-zA-Z0-9-]+$/;

/**
 * OpenAI 兼容协议对 LLM 工具名（function.name）的字符集硬约束——DeepSeek / OpenAI
 * 等强校验上游对非法字符整单 400（与目录段白名单不同，`_` 可用）。
 *
 * 嵌套名（各段满足 {@link DIR_SEGMENT_PATTERN} + `_` 连接）恒满足本 pattern——
 * 段内字符集是工具名字符集的子集，`_` 只出现在连接位，不存在段内违例路径。
 */
export const LLM_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
