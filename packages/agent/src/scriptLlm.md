# scriptLlm

一句话概括：`createScriptLLM(turns)` 官方脚本假 LLM——按序回放预设回合（纯文本收尾或发起 tool_calls）、快照每轮完整请求、脚本用尽再被调用即抛错，返回 `{ provider, requests }`，供 agent 流程测试作 `options.provider` 注入。

## 为什么需要

agent 流程测试需要确定性 LLM：真 provider 发真实请求（慢、贵、不确定），手写 mock provider（`complete` 按序列返回 + 请求记录 + stream 抛错）是每个项目、每个测试文件各抄一份的机械（框架自身 `agent.e2e.test.ts` 也曾内联同款实现）。脚本假体的语义（按序回放、快照断言、用尽显式失败）是零业务语义的通用件，官方化后各项目不必各抄一份。

## 使用场景

- `Agent.run` / `Agent.stream` 的流程测试：`agent.run(input, { agent, provider: llm.provider })`——无默认 provider 的外部注入模式，脚本假体天然契合
- 跨主控 / 子代理连续编排：子代理递归继承同一 provider 实例，脚本跨主控与子代理按调用顺序连续回放（一个脚本编排整棵调用树）
- 断言历史 / 系统提示词 / 工具结果回灌：`requests[i]` 是发给 LLM 的完整请求快照（`LLMCompleteRequest`）

## 公开 API

```ts
import { createScriptLLM, type ScriptTurn, type ScriptedLLM } from '@faapi/agent';
```

### 入参 `ScriptTurn[]`

| 字段 | 类型 | 说明 |
|------|------|------|
| `content` | `string`（可选） | assistant 回合的文本内容；与 `toolCalls` 均省略时为空文本回合 |
| `toolCalls` | `Array<{ name, arguments }>`（可选） | 发起的工具调用；`arguments` 为对象，序列化为 JSON 字符串（OpenAI 规范形）。非空时 `stopReason` 为 `'tool_calls'`，否则 `'stop'` |

### 返回 `ScriptedLLM`

| 字段 | 类型 | 说明 |
|------|------|------|
| `provider` | `LLMProvider`（`ScriptedLLM` 自身即 provider） | `complete` 按序回放；`stream` 把同一回合转为流式 chunk（`deltaContent` + `toolCalls`/`finishReason` + `usage`）——两种消费模式共享同一游标与快照 |
| `requests` | `LLMCompleteRequest[]` | 每轮发给 LLM 的完整请求快照（含 messages / tools / system），断言用 |

## 行为约定

- **按序回放**：每次 `complete` / `stream` 调用消费下一个回合，两种模式共享同一游标（先 stream 后 complete 也按序推进）
- **快照在回放前记录**：`requests` 先 push 再取回合——即使脚本用尽抛错，该次请求也已留痕（第 N 轮请求可在快照中检视）
- **脚本用尽即抛**：游标越界时抛 `Error`（消息含已调用轮次与「用例未收敛」指引）——用例必须显式收敛，超用 = 用例写错，不静默返回空回合
- **回合身份确定性**：tool call id 为 `call_<回合序号>_<序内下标>`（从 1 计），断言可依赖
- **usage 恒定占位**：`{ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }`——流程测试不测计费，占位值让 usage 断言确定性成立

## 示例

```ts
import { describe, it, expect } from 'vitest';
import { Agent, createScriptLLM } from '@faapi/agent';

it('工具结果按生产口径回灌 LLM', async () => {
  const llm = createScriptLLM([
    { toolCalls: [{ name: 'weather_getWeather', arguments: { city: '北京' } }] },
    { content: '北京晴，26 度' },
  ]);
  const agent = new Agent({ /* deps：注册表 + loader 来自 createAgentTestHarness */ });

  const result = await agent.run('北京天气', { agent: 'researcher', provider: llm });

  // 断言回灌：第 2 轮请求的 messages 里 role='tool' 的内容即工具执行结果
  const toolMsg = llm.requests[1]!.messages.find((m) => m.role === 'tool');
  expect(String(toolMsg?.content)).toContain('26');
  expect(result.messages.at(-1)?.content).toBe('北京晴，26 度');
});
```

## 相关模块

- [provider.md](./provider.md) - `LLMProvider` / `LLMCompleteRequest` / `LLMResponse` 类型定义方
- [agent.md](./agent.md) - `Agent.run` / `Agent.stream` 的 `options.provider` 注入语义
- faapi 核心 [agentTestHarness.md](../../faapi/src/agentTestHarness.md) - `createAgentTestHarness`（注册表 + loader 来自它，假 LLM 来自本模块——机械与配方的分工）
