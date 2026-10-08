# lightComplete（轻量 LLM 补全通道）

一句话概括：agent 工具循环之外的一次性 LLM 补全官方通道——字符串进字符串出，复用 `agent.llms` 同源配置与 provider 重试引擎，超时/错误分型/失败钩子内建，降级永不静默。

## 为什么需要

ReAct 循环（`agent.run`）之外的「一次性补全」是高频场景：分类、摘要蒸馏、字段补全、inline 改写、取材预填。此前框架只有 agent 循环一条 LLM 通道，这些调用点业务方只能手搓 fetch——超时/重试/错误分型各自为政（同一项目出现 50s/60s 两套超时、零重试、裸 Error 字符串），失败被静默吞掉（真实事故：切章分类超时静默回落纯正则，整书错误切分无人知晓）。

传输机制（重试引擎 `fetchOkWithRetry`：maxRetries 默认 2、指数退避、Retry-After、429/5xx/网络错误判定；`LlmConfig.timeoutMs` 超时；`LLMProviderError` 错误分型）早已在 provider 层存在，缺的只是 agent 循环之外的出口。本模块提供该出口——**只统一传输机制，策略留给调用方**：

1. 连接 `agent.llms` 同源配置，项目零新增配置；
2. 复用 provider 重试引擎（maxRetries / 指数退避 / Retry-After / 429·5xx 判定）；
3. 默认超时（60s）+ 错误分型（`LLMTimeoutError` 与 HTTP `status` 可编程区分）；
4. 必带失败钩子 `onFailure`——「失败留痕/降级」是默认行为而非各项目纪律（约定：LLM 失败可降级不可静默——`fallback` 命中且未声明 `onFailure` 时框架兜底 `console.warn`）；
5. 重试次数（`maxRetries`）、失败后降级（`fallback`）还是抛，由调用方按调用声明（导入切章要降级、面向用户的单发要直接回人，框架不代劳）。

## 使用场景

handler 经 `llm` 注入参数（插件未加载时 `undefined`）：

```ts
// src/api/classify/handler.ts
import type { LlmComplete } from '@faapi/agent';
import { LLMTimeoutError } from '@faapi/agent';

export async function POST(llm: LlmComplete, body: { title: string }) {
  try {
    const category = await llm.complete(body.title, {
      model: 'deepseek/deepseek-chat',       // llms key / provider/model / 纯 model 名，同 agent.run 解析规则
      system: '输出分类标签，不要解释。',
      maxRetries: 1,                          // 场景声明：导入类要快失败
      fallback: 'uncategorized',              // 场景声明：失败降级（框架兜底 warn 留痕）
    });
    return { category };
  } catch (err) {
    if (err instanceof LLMTimeoutError) { /* 超时分型处理 */ }
    if (err instanceof LLMProviderError && err.status === 502) { /* 网关分型 */ }
    throw err;
  }
}
```

任务经 `taskCtx.llm`（两条执行路径均注入；`@faapi/agent` 未安装/未加载时 `undefined`）：

```ts
// src/tasks/distill/task.ts
export async function run(payload, taskCtx) {
  if (!taskCtx.llm) throw new Error('llm channel unavailable');
  const summary = await taskCtx.llm.complete(payload.text, { model: 'gpt-4o-mini' });
}
```

编程式 / worker 内重建：`createLightComplete({ llms, providers? })`——`providers` 缺省时按 `llms` 逐项 `createProvider` 现场构建（隔离 worker 即此形态：`llms` 纯数据跨线程，worker 内重建实例）。

## 行为契约

| 维度 | 行为 |
|------|------|
| 入参 | `complete(input, options?)` → `Promise<string>`（assistant content，恒字符串；不发 tools，LLM 不会请求 tool_call） |
| model 解析 | 复用 agent 的字符串 key 规则（llms key / `provider/model` / 纯 model 名全 provider 查找，歧义抛错）；缺省回落 llms 第一个 provider 的第一个 model |
| 超时 | `options.timeoutMs` > 目标 provider 的 `LlmConfig.timeoutMs` > 默认 60_000 |
| 重试 | `options.maxRetries` > `LlmConfig.maxRetries`（默认 2，0 关闭）；429/5xx/网络错误/超时计入重试 |
| 传输失败（重试耗尽） | 声明 `onFailure` → 调用后抛 `LLMProviderError`；声明 `fallback` → 返回 fallback（无 `onFailure` 时框架 `console.warn` 兜底留痕）；两者独立可组合 |
| 用户取消（`options.signal`） | 恒抛 `AgentAbortError`——取消不是故障：不走 fallback、不触发 onFailure、不 warn |
| 配置错误（model 解析失败 / llms 空） | 立即抛 `AgentError`——编程/配置错误不重试、不降级 |
| 响应携带 | `LLMResponse.attempts`（实际 HTTP 尝试次数，≥1）供钩子/日志观测重试 |

## 相关模块

- [provider](./provider.md) / [providers/openai](./providers/openai.md)——重试引擎、超时信号、`LLMProviderError`/`LLMTimeoutError` 分型；request 级 `timeoutMs`/`maxRetries` 覆盖
- [agent](./agent.md)——`resolveModelKey` 字符串 key 解析规则（同源复用）；`AgentError`
- [plugin](./plugin.md)——setup 时构建 channel（共享 providers 单例）注册到 `registries.llm`
- 主包 [llmTypes](../../faapi/src/injection/llmTypes.md)——`LlmComplete` / `LlmCompleteOptions` 规范类型（主包持有：`TaskContext` 等主包类型需引用，主包不反向依赖本包）
- 主包 [registries](../../faapi/src/injection/registries.md)——`LlmChannelStore`；[injectParams](../../faapi/src/injection/injectParams.md)——`llm` 注入参数
- 主包 task 子系统——`taskCtx.llm` 双路径注入（进程内活引用 / 隔离 worker 快照重建，见 [taskTypes](../../faapi/src/task/taskTypes.md)）
