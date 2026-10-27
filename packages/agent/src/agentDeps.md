# agentDeps

一句话概括：`createAgentDeps(options)` 官方 deps 装配工厂——从注册表视图 + agent 配置构造完整 `AgentDeps`，插件 setup 与任务内组装/自组装共用同一装配；`agentConfig` 参数直收 `faapi.config.ts` 的 `agent` 块复合形状（llms + 运行时旋钮），业务只声明差异项（装饰钩子、schema 富化、配置覆盖），不再逐字段复刻框架工厂的访问器拼装、也不必手工拆装复合配置块。

## 为什么需要

`Agent` 类按依赖注入设计（`AgentDeps` 访问器签名与 faapi 核心对称），装配逻辑原本是 `@faapi/agent` 插件 setup 的内部实现（plugin.ts 闭包）。两类场景被迫镜像这份拼装：

1. **任务内组装**——`TaskContext.registries` 只读视图在手，但任务的 `taskCtx` 没有 agentHandle 工厂（那是 HTTP 请求链路的注入通道），任务内跑 agent 只能 `new Agent(deps)` 手拼：7 个注册表访问器 + `loadToolModule` 桥接 + schema 解析器接线，逐字段复刻框架工厂
2. **自组装**——业务要在框架工厂产物之上叠加自己的配方（`emitAppEvent` 桥接独立事件总线、schema 富化、`maxHistoryTokens` 等），而框架工厂不透传定制点；业务于是整体绕开插件工厂自建组装点，deps 拼装随之复刻一份

框架文档（`agent.md`「派发入参 schema 声明」的编程式组装路径、`toolSchemaResolver.md` 任务侧示例）展示的就是手拼形态——框架亲手把定制业务推向机械。本模块把「从 registries + llms 构造 deps」抽为单一实现：插件 setup 改调它，任务内/自组装也调它，机械只此一份。

复合配置块的拆装同理收进本工厂：`faapi.config.ts` 的 `agent` 块（`AgentConfig`）是 llms 目录与运行时旋钮的复合形状，历史上（≤6.4x）deps 装配消费的是 `llms` 与 `config: AgentRuntimeConfig` 双参数——插件 setup 与业务自组装各自手工逐字段拆装，框架每新增一个旋钮两处清单都要记得补，漏掉的那侧**静默缺失**（实证：`enableTracing` 曾在插件侧清单漏拼，`faapi.config` 配置后静默不生效）。`agentConfig` 参数直收复合块（6.50 引入、7.0 起成为唯一入口——分离参数已删除），拆装清单只在 `toAgentRuntimeConfig` 一处维护，插件与自组装两路自动到达。

## 使用场景

- **任务内组装 agent**（主要场景）：进程内任务用静默通道 `taskCtx.agent`（框架以 carry + 任务级能力合成契约 ctx 构造，见 faapi 的 taskToolContext.md）；手工组装时 `new Agent(createAgentDeps({ registries: taskCtx.registries, ctx: createTaskToolContext({ carry: taskCtx.carry, tasks: taskCtx.tasks, log: taskCtx.log, signal: taskCtx.signal }), agentConfig: taskCtx.config.agent }))`——`AgentDeps.ctx` 为**必填**的 `AgentToolContext` 契约（类型声明在主包，三路径合成规则见 faapi 的 agentToolContext.md）
- **自组装单点**：业务组装工厂（如 writer 的 `buildAppAgent`）用 `overrides` 叠加差异项——`emitAppEvent` 桥接、schema 富化包装、config 覆盖——访问器拼装不再复刻（流程类扩展已全量事件化，订阅 `src/bootstrap.ts`，不走 overrides）
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
  /** 执行上下文契约（必填，AgentToolContext——authHooks 与 tool handler 第二参数读取；无 app 场景用 createStandaloneToolContext 构造） */
  ctx: AgentToolContext;
  /** 项目根目录（loadToolModule 桥接与 schema 解析器定位用；缺省 process.cwd()） */
  rootDir?: string;
  /**
   * faapi.config 的 `agent` 块复合形状（llms + 运行时旋钮）——唯一配置入口，
   * 可整体透传 `ctx.config.agent` / `taskCtx.config.agent` 读回值。llms 逐项
   * `createProvider` 转换 providers Map（model key 解析用），旋钮经
   * `toAgentRuntimeConfig` 全量拆装（清单单一维护，含 enableTracing /
   * toolTimeoutMs / maxHistoryTokens 等声明面旋钮）。缺省为空 Map + 无 config
   * （外部 provider 模式——`agent.run(input, { provider })` 每次显式注入）
   */
  agentConfig?: AgentConfig;
  /**
   * 差异项覆盖（浅合并，最后应用、优先级最高）——装饰钩子 / schema 富化 /
   * 单个访问器定制 / providers 直传（绕过 llms 转换）/ 测试桥接等编程级差异
   */
  overrides?: Partial<AgentDeps>;
}

function createAgentDeps(options: CreateAgentDepsOptions): AgentDeps;
```

## 行为约定

- **纯装配无副作用**：不注册 handle 工厂、不建 app、不触碰全局状态；每次调用返回独立的 deps 对象（providers Map、schema 解析器缓存均随 deps 生命周期）——**进程级复用由调用方负责**：插件 setup 调一次天然闭包单例；任务侧建议模块级创建一次（进程内任务跨执行复用；隔离 worker 每次执行新模块图，缓存随执行重建）
- **schema 解析器**：默认内部 `createToolSchemaResolver({ rootDir })`（同一实例注入 `resolveToolSchema` + `resolveAgentInputSchema`，tool 与派发入参共用缓存）；经 `overrides` 覆盖时（如富化包装）以覆盖值为准
- **空 apiKey 照常注册 provider**：部分网关/本地模型场景无需 key；「key 未配置」的启动期显性提示由插件 setup 负责（工厂可能在任务内调用，不在此处刷警告）——上游 401 的错误文案来自上游，可按 provider 名定位
- **overrides 浅合并**：`{ ...decorated, ...overrides }`——覆盖单个访问器不影响其余装配；需要深度定制时用完整的编程式组装（`new Agent(deps)` 直拼）
- **agentConfig 是唯一配置入口**（7.0 起删除了历史的 `llms` / `config` 分离参数）：`resolvedLlms = agentConfig?.llms ?? {}`、`resolvedConfig = agentConfig ? toAgentRuntimeConfig(agentConfig) : undefined`——配置数值归 `agentConfig`，进程级配方归 `decorateDeps`，编程级差异归 `overrides`
- **decorateDeps 装配次序**：`base → agentConfig.decorateDeps → overrides`——config 声明的进程级 deps 配方（schema 富化包装 / providers 复用等，真实签名 `(deps: AgentDeps) => AgentDeps`，主包按接受任意函数的手法声明、业务侧从本包导入 `AgentDeps` 强类型书写）在 base 之上叠加，调用方显式 `overrides` 同名字段优先；配方抛错原样冒泡（fail fast）。插件 setup 与业务自组装都走本工厂——配方一次声明两路到达，请求级差异（`ctx`）不归本钩子。`@faapi/agent` 插件经 `overrides.emitAppEvent` 注入 app 事件发射器（[appEventBus](../../faapi/src/events/appEventBus.md)，来源 `registries.appEvents.emit`）；输入改写类扩展已由 `agent:root-input` / `agent:input` 事件承载（原 `resolveRootInput` / `resolveSubAgentInput` 钩子已移除，见 [agent](./agent.md) 事件章节）
- **不产生 providers/llms 之外的隐式依赖**：`agentConfig` 未提供（或未配 llms）即外部 provider 模式，与插件「llms 可选」语义一致

## 示例

### 任务内组装

```ts
// src/tasks/log-analysis/task.ts
import { Agent, createAgentDeps } from '@faapi/agent';
import type { AgentConfig } from '@faapi/faapi';
import type { TaskContext } from '@faapi/faapi';

export async function run(payload, taskCtx: TaskContext) {
  // 配置单一来源：faapi.config.ts 的 agent 块，taskCtx.config 活引用读回
  // （FaapiContextConfig 为开放 Record，读回时按 AgentConfig 断言形状）
  const agentConfig = taskCtx.config.agent as AgentConfig | undefined;
  const agent = new Agent(
    createAgentDeps({
      registries: taskCtx.registries, // 只读视图，最小结构直传
      agentConfig,
      ctx: createTaskToolContext({ carry: payload, tasks: taskCtx.tasks, log: taskCtx.log, signal: taskCtx.signal }), // 契约 ctx 合成（身份在 carry 数据字段落顶层）
    }),
  );
  return agent.run(payload.input, { agent: 'log-analyzer', model: 'gpt-4o' });
}
```

> 进程内任务若高频组装，可把 `createAgentDeps` 提到模块级、`registries` 经 run 参数注入——providers Map 与 schema 解析器缓存随 deps 生命周期，跨执行复用。

### 自组装单点（叠加业务配方）

进程级 deps 配方优先经 `faapi.config.ts` 的 `agent.decorateDeps` 声明（插件路径的注入 AgentHandle 与自组装路径共用同一配方）；仅在调用点才知道的差异项才走 `overrides`：

```ts
// faapi.config.ts —— 配方声明（实现函数从 lib 导入，配置在此声明）
import { decorateAgentDeps } from './src/lib/agent-deps-recipe';

export default {
  agent: {
    llms: { openai: { provider: 'openai', apiKey: process.env.OPENAI_API_KEY, models: { 'gpt-4o': {} } } },
    decorateDeps: decorateAgentDeps, // (deps: AgentDeps) => AgentDeps
  },
} satisfies FaapiConfig;

// src/lib/agent-assembly.ts —— 自组装读回同一配置（decorateDeps 已在工厂内应用）
import { Agent, createAgentDeps } from '@faapi/agent';
import type { AgentConfig } from '@faapi/faapi';

export function buildAppAgent(ctx: FaapiContext): Agent {
  const agentConfig = ctx.config?.agent as AgentConfig | undefined;
  return new Agent(
    createAgentDeps({ ctx, registries: ctx.registries, agentConfig }),
  );
}
```

### 历史超限承接走事件订阅（原 historyCompactor 策略旋钮已移除）

框架不内置裁剪/压缩——`maxHistoryTokens` 只是超限阈值，超限时发射 `agent:history-over-budget` 事件，压缩产物经 `replace` 整体替换循环历史。承接面是 **app 事件订阅**（`src/bootstrap.ts`），不走 `decorateDeps`：

```ts
// src/bootstrap.ts
import { getApp } from '@faapi/faapi';

getApp().on('agent:history-over-budget', async (e) => {
  // 业务自搓压缩（如调 LLM 把旧轮组折成摘要）,产物整体替换循环历史
  const compacted = await compactHistory(e.messages, e.budget);
  e.replace(compacted);
});
```

`decorateDeps` 仍承载其他进程级配方（schema 富化包装 / providers 复用等，见上文装配次序）。

## 相关模块

- [agent](./agent.md) —— `AgentDeps` 契约定义方与消费方（编程式组装的完全体形态）
- [plugin](./plugin.md) —— 插件 setup 的调用方（装配单一实现的验证场）
- faapi 核心 [configTypes](../../faapi/src/configs/configTypes.md) —— `AgentConfig` 复合形状定义方（`agentConfig` 参数的同构来源）
- [toolSchemaResolver](../../faapi/src/loaders/toolSchemaResolver.md) —— 默认 schema 解析器（`overrides` 富化包装的底层）
- faapi 核心 [agentTestHarness](../../faapi/src/agentTestHarness.md) —— 测试设施的 `registries` 可直传本工厂（同一最小结构）
- faapi 核心 [registries](../../faapi/src/injection/registries.md) —— 注册表实例与只读视图（`registries` 参数的三种来源）
