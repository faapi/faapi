# agentDeps

一句话概括：`createAgentDeps(options)` 官方 deps 装配工厂——从注册表视图 + llms 配置构造完整 `AgentDeps`，插件 setup 与任务内组装/自组装共用同一装配，业务只声明差异项（装饰钩子、schema 富化、配置覆盖），不再逐字段复刻框架工厂的访问器拼装。

## 为什么需要

`Agent` 类按依赖注入设计（`AgentDeps` 访问器签名与 faapi 核心对称），装配逻辑原本是 `@faapi/agent` 插件 setup 的内部实现（plugin.ts 闭包）。两类场景被迫镜像这份拼装：

1. **任务内组装**——`TaskContext.registries` 只读视图在手，但任务的 `taskCtx` 没有 agentHandle 工厂（那是 HTTP 请求链路的注入通道），任务内跑 agent 只能 `new Agent(deps)` 手拼：7 个注册表访问器 + `loadToolModule` 桥接 + schema 解析器接线，逐字段复刻框架工厂
2. **自组装**——业务要在框架工厂产物之上叠加自己的配方（`resolveSystemPrompt` 装饰、schema 富化、`maxHistoryTokens` 等），而框架工厂不透传定制点；业务于是整体绕开插件工厂自建组装点，deps 拼装随之复刻一份

框架文档（`agent.md`「派发入参 schema 声明」的编程式组装路径、`toolSchemaResolver.md` 任务侧示例）展示的就是手拼形态——框架亲手把定制业务推向机械。本模块把「从 registries + llms 构造 deps」抽为单一实现：插件 setup 改调它，任务内/自组装也调它，机械只此一份。

## 使用场景

- **任务内组装 agent**（主要场景）：`src/tasks/<name>/task.ts` 中 `new Agent(createAgentDeps({ registries: taskCtx.registries, llms, rootDir }))`——任务数据经 payload 显式传入，鉴权身份经 `ctx` 窄对象透传（框架契约：`AgentDeps.ctx` 为 `Partial<FaapiContext>` 纯透传）
- **自组装单点**：业务组装工厂（如 writer 的 `buildAppAgent`）用 `overrides` 叠加差异项——`resolveSystemPrompt` 装饰、schema 富化包装、config 覆盖——访问器拼装不再复刻
- **插件 setup**：`@faapi/agent` 插件内部同样经本工厂装配（与任务侧单一实现，不出现适配漂移）
- **测试设施**：`createAgentTestHarness` 的 `registries` + `loadToolModule` 可经 `overrides` 接进同一装配（harness 自带桥接形态与此工厂同构）

## 公开 API

```ts
import { createAgentDeps } from '@faapi/agent';

interface CreateAgentDepsOptions {
  /**
   * 注册表视图（必填）——最小结构，三种来源均可直传：
   * `ctx.registries`（FaapiContext/PluginContext 的 AppRegistries）、
   * `taskCtx.registries`（TaskRegistriesView 只读视图）、
   * 测试设施的 `harness.registries`
   */
  registries: {
    agent: Pick<AgentRegistry, 'getAgent' | 'getAgentEntry' | 'resolveAgentTools' | 'resolveSubAgents'>;
    tool: Pick<ToolRegistry, 'get'>;
  };
  /** 请求/任务上下文透传（AgentDeps.ctx：authHooks 与 tool handler 第二参数读取） */
  ctx?: Partial<FaapiContext>;
  /** 项目根目录（loadToolModule 桥接与 schema 解析器定位用；缺省 process.cwd()） */
  rootDir?: string;
  /**
   * LLM provider 配置（key 为 provider 名）。提供时逐项 `createProvider` 转换为
   * providers Map 并透传 llms（model key 解析用）；缺省为空 Map + 空 llms
   * （外部 provider 模式——`agent.run(input, { provider })` 每次显式注入）
   */
  llms?: Record<string, LlmConfig>;
  /** 全局 agent 运行时配置（maxTurns / maxAgentDepth / maxHistoryTokens / 三鉴权钩子） */
  config?: AgentRuntimeConfig;
  /**
   * 差异项覆盖（浅合并，最后应用、优先级最高）——装饰钩子 / schema 富化 /
   * 单个访问器定制 / providers 直传（绕过 llms 转换）等
   */
  overrides?: Partial<AgentDeps>;
}

function createAgentDeps(options: CreateAgentDepsOptions): AgentDeps;
```

## 行为约定

- **纯装配无副作用**：不注册 handle 工厂、不建 app、不触碰全局状态；每次调用返回独立的 deps 对象（providers Map、schema 解析器缓存均随 deps 生命周期）——**进程级复用由调用方负责**：插件 setup 调一次天然闭包单例；任务侧建议模块级创建一次（进程内任务跨执行复用；隔离 worker 每次执行新模块图，缓存随执行重建）
- **schema 解析器**：默认内部 `createToolSchemaResolver({ rootDir })`（同一实例注入 `resolveToolSchema` + `resolveAgentInputSchema`，tool 与派发入参共用缓存）；经 `overrides` 覆盖时（如富化包装）以覆盖值为准
- **空 apiKey 照常注册 provider**：部分网关/本地模型场景无需 key；「key 未配置」的启动期显性提示由插件 setup 负责（工厂可能在任务内调用，不在此处刷警告）——上游 401 的错误文案来自上游，可按 provider 名定位
- **overrides 浅合并**：`{ ...base, ...overrides }`——覆盖单个访问器不影响其余装配；需要深度定制时用完整的编程式组装（`new Agent(deps)` 直拼）
- **不产生 providers/llms 之外的隐式依赖**：`llms` 未提供即外部 provider 模式，与插件「llms 可选」语义一致

## 示例

### 任务内组装

```ts
// src/tasks/log-analysis/task.ts
import { Agent, createAgentDeps } from '@faapi/agent';
import type { TaskContext } from '@faapi/faapi';

const llms = {
  openai: { provider: 'openai', apiKey: process.env.OPENAI_API_KEY, models: { 'gpt-4o': {} } },
};

export async function run(payload, taskCtx: TaskContext) {
  const agent = new Agent(
    createAgentDeps({
      registries: taskCtx.registries, // 只读视图，最小结构直传
      llms,
      ctx: { currentUserId: payload.userId }, // 鉴权身份窄对象透传（框架契约）
    }),
  );
  return agent.run(payload.input, { agent: 'log-analyzer', model: 'gpt-4o' });
}
```

> 进程内任务若高频组装，可把 `createAgentDeps` 提到模块级、`registries` 经 run 参数注入——providers Map 与 schema 解析器缓存随 deps 生命周期，跨执行复用。

### 自组装单点（叠加业务配方）

```ts
// src/lib/agent-assembly.ts
import { Agent, createAgentDeps, type AgentDeps } from '@faapi/agent';

export function buildAppAgent(ctx: FaapiContext): Agent {
  const base = createAgentDeps({
    ctx,
    registries: ctx.registries,
    llms: AGENT_RUNTIME.llms,
    config: AGENT_RUNTIME.config,
    overrides: {
      resolveSystemPrompt: createSystemPromptResolver(),        // 业务提示词装饰
      resolveToolSchema: enrichToolSchemas(ctx.rootDir),        // 业务 schema 富化
    },
  });
  return new Agent(base);
}
```

## 相关模块

- [agent](./agent.md) —— `AgentDeps` 契约定义方与消费方（编程式组装的完全体形态）
- [plugin](./plugin.md) —— 插件 setup 的调用方（装配单一实现的验证场）
- [toolSchemaResolver](../../faapi/src/loader/toolSchemaResolver.md) —— 默认 schema 解析器（`overrides` 富化包装的底层）
- faapi 核心 [agentTestHarness](../../faapi/src/agentTestHarness.md) —— 测试设施的 `registries` 可直传本工厂（同一最小结构）
- faapi 核心 [registries](../../faapi/src/injection/registries.md) —— 注册表实例与只读视图（`registries` 参数的三种来源）
