# nameRules

一句话概括：agent / tool / task 三域共用的命名白名单唯一定义处——`DIR_SEGMENT_PATTERN`（目录段白名单）与 `LLM_TOOL_NAME_PATTERN`（LLM 工具名字符集）。

## 为什么需要

三个 scanner（[scanAgents](../agents/scanAgents.md) / [scanTools](../tools/scanTools.md) / [scanTasks](../tasks/scanTasks.md)）的目录段白名单必须同规则——三域各自持有一份常量的话，规则调整要三处同步，漏改即命名口径分裂（如 task 允许了 tool 拒绝的字符，「目录路径 → 注册名」的单射保证在跨域层面失效）。本模块把白名单收敛为唯一定义处。

两条 pattern 的语义分工：

- **`DIR_SEGMENT_PATTERN = /^[a-zA-Z0-9-]+$/`**——目录段白名单。`_` 被 `/` 规范化独占为嵌套分隔符（段内出现会让「嵌套」与「段内下划线」不可区分，跨路径同名冲突检测失效），`.` 等其余字符拒绝。保证「目录路径 → 注册名」映射单射。
- **`LLM_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$`**——OpenAI 兼容协议对 LLM `function.name` 的硬约束（`_` 可用），DeepSeek / OpenAI 等强校验上游对非法字符整单 400。

嵌套名（各段满足 `DIR_SEGMENT_PATTERN` + `_` 连接）恒满足 `LLM_TOOL_NAME_PATTERN`——段内字符集是工具名字符集的子集，`_` 只出现在连接位，不存在段内违例路径。

## 使用场景

- agent 目录段校验（`src/agents/<path>/handler.ts`）、tool 目录段校验（`src/tools/<path>/handler.ts`）、task 目录段校验（`src/tasks/<path>/task.ts`）——三域共用 `DIR_SEGMENT_PATTERN`
- tool 合成名校验（`子目录_函数名`）与 sub-agent 派发工具名运行时闸门（[subAgentToolName](../injection/subAgentToolName.md)）——用 `LLM_TOOL_NAME_PATTERN`
- 未来任何新的「目录即标识」域（如新增的资源类型 scanner）直接 import 本模块，不再复制常量

## 相关模块

- [scanAgents](../agents/scanAgents.md) - agent 目录段校验消费方
- [scanTools](../tools/scanTools.md) - tool 目录段 + 合成名校验消费方
- [scanTasks](../tasks/scanTasks.md) - task 目录段校验消费方
- [subAgentToolName](../injection/subAgentToolName.md) - `LLM_TOOL_NAME_PATTERN` 再导出（公共 API 保持不变）与派发名运行时闸门
