# @faapi/agent

> faapi 的 agent 运行时——在已扫描的 agent / tool 注册表之上提供 LLM 驱动的 ReAct 循环

`@faapi/agent` 组合 faapi 核心包已生成的 `faapi-agents.js` + `faapi-tools.js` 清单，提供：

- **LLM Provider 抽象**（Phase 3.2）—— 统一接口对接 OpenAI / Anthropic 等 provider
- **ReAct 循环引擎**（Phase 3.3）—— LLM 输出 → 调用 tool / 递归 sub-agent → 把结果回灌给 LLM，循环直到最终回答
- **Agent 类**（Phase 3.4）—— 按 `agent.name` 查找元数据、加载 handler、组装 agent.tools + defaultTools + sub-agent，提供 `run` / `stream` / `asTool`
- **递归防护** —— `maxTurns` + `maxAgentDepth`（来自 `config.agent` 或 agent 自身 `config` 块）

## 与 faapi 核心的关系

```
faapi 核心（@faapi/faapi）           @faapi/agent（本包）
────────────────────────────         ────────────────────────────
scanAgents  →  faapi-agents.js   ──→  Agent.run / stream
scanTools   →  faapi-tools.js    ──→  reactLoop 组装 tool 列表
agentRegistry / toolRegistry     ──→  resolveAgentTools / resolveSubAgents / asTool
loadAgentModule / loadToolModule ──→  reactLoop 执行 tool / sub-agent
config.agent（llm / maxTurns …）  ──→  Agent 类构造参数
```

核心包负责扫描与产物生成（dev/prod 一致），本包负责运行时编排——LLM 调用、tool 分发、递归控制、流式输出。

## 安装

```bash
pnpm add @faapi/agent
# 或
npm install @faapi/agent
```

要求 Node.js >= 24。

> 当前为 canary 阶段（Phase 3.x 持续开发中），API 可能在稳定前调整。

## 启用方式

在 `faapi.config.ts` 的 `plugins` 中声明即启用 agent 运行时（Phase 3.5 集成）：

```ts
import type { FaapiConfig } from '@faapi/faapi';

export default {
  agent: {
    llm: {
      provider: 'openai',
      apiKey: process.env.OPENAI_API_KEY,
      model: 'gpt-4o',
    },
    defaultAgent: 'researcher',
    maxTurns: 10,
    maxAgentDepth: 3,
  },
  plugins: ['@faapi/agent'],
} satisfies FaapiConfig;
```

CLI 启动时动态加载——未安装时自动跳过，不影响核心功能。需单独安装：`pnpm add @faapi/agent`。

## 多 agent 组织

agent 与 tool 的目录约定（由 faapi 核心包扫描，详见 [AGENTS.md 5.4](../../../AGENTS.md)）：

```
src/
├── tools/                          ← 所有 tool（agent 通过 config.tools 显式引用）
│   └── weather/handler.ts
├── agents/
│   ├── researcher/                 ← agent "researcher"
│   │   └── handler.ts             ← export const config / export function run
│   └── writer/
│       └── handler.ts             ← config.agents: ['researcher'] → 可调用 researcher
```

- tool 位置：`src/tools/**`（所有 tool 统一放此目录，无 agent 专属 tool 概念）
- agent 可用 tool：在 agent 的 `config.tools` 字段显式声明引用 tool 名
- sub-agent：在 agent 的 `config.agents` 字段声明可调用的其他 agent 名

## 状态

Phase 3.1：包骨架初始化（按 [AGENTS.md 6.5](../../../AGENTS.md) 清单配置）。

## 许可证

[MIT](https://github.com/faapi/faapi/blob/main/LICENSE)
