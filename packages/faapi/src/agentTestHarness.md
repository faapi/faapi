# agentTestHarness

一句话概括：公开导出 `createAgentTestHarness`，测试进程内扫描 agent/tool 源码 → AST 增强 → 水合出与生产同接口的注册表视图 + 可拼装 `AgentDeps` 的 loader 桥接——agent 流程测试（真 reactLoop + 真工具 + 假 LLM）的官方设施，对位 HTTP 层的 `createTestServer`。

## 为什么需要

agent 的进程内流程测试此前没有官方设施。真注册表只能由 dev/prod app 启动时装载（构建期产物），测试进程想不起 app 就得手搓「扫描器等价物」：逐个 import agent config / tool handler、手打最终工具名映射表（`@tool` 覆盖名是手维护的漂移面）、查表替代 loadToolModule、schema 放行桩。每个 faapi 项目做同类测试都要重抄这份机械，且桩接口不全会被组装层掩盖（如漏实现 `resolveSubAgents` 在某些路径静默走默认）。

`createTestServer` 已证明 faapi 愿意在测试进程里跑同构管线（scanRoutes + 现场生成 zod.js + 起 server），本模块把同款取舍发给 agent 层：扫描、AST 增强、注册表水合、loader 桥接全部复用 dev/build 管线现成件，测试只留配方（假 LLM 脚本编排、场景断言）。

## 使用场景

- agent 流程集成测试：真 `reactLoop`（`@faapi/agent` 的 `Agent` 类）+ 真 tool handler + 脚本假 LLM，测派发路由、交接单传导、鉴权门禁、状态推进等编排行为（文本质量不在覆盖范围）
- harness 的注册表视图整体塞进 `ctx.registries` 桩，供 HTTP 层集成测试走生产注入路径
- 断言 agent 注册名 / tool 最终名（含 `@tool` 覆盖）/ sub-agent 集合与生产一致（与 dev 水合同管线，阴性对照见测试）

## 公开 API

```ts
import { createAgentTestHarness, type AgentTestHarness, type AgentTestHarnessOptions } from '@faapi/faapi/testing';
```

### 入参 `AgentTestHarnessOptions`

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `rootDir` | `string` | — | 项目根目录（agent/tool 源码所在，必填；目录不存在显式抛错） |
| `schemaMode` | `'free-form' \| 'generated'` | `'free-form'` | 工具入参 schema 模式，见下表 |
| `agentPatterns` | `string[]` | `DEFAULT_AGENT_PATTERNS` | agent 扫描 glob，相对 rootDir（与 dev 启动一致） |
| `toolPatterns` | `string[]` | `TOOL_PATTERNS` | tool 扫描 glob，相对 rootDir（与 dev/build 一致；agent 本地 tools 项目显式传，如 `['src/tools/**/*.ts', 'src/agents/*/tools/**/*.ts']`） |
| `dist` | `string` | 自动 `mkdtemp` 临时目录 | 编译/schema 产物输出目录（绝对路径或相对 rootDir），`close()` 时清理 |

**`schemaMode` 语义**：

| 模式 | 行为 |
|------|------|
| `'free-form'`（默认） | 放行为自由 schema——不生成 zod.js、不提供 `resolveToolSchema` / `resolveAgentInputSchema`（`Agent` 类对未接线的 deps 用自由 schema `{ type: 'object' }`），入参合法性由 tool handler 自行校验。适合脚本假 LLM 的场景：脚本入参本就是用例给的，免 schema 约束 |
| `'generated'` | 现场生成 zod.js（tool 的入参 schema + 声明 `Input` 的 agent 派发入参 schema）并按生产口径解析——流程测试同时覆盖「LLM 可见 schema + 派发/工具入参校验」这一层。对位 `createTestServer` 的 `generateSchemaFiles` |

### 返回 `AgentTestHarness`

| 字段 | 类型 | 说明 |
|------|------|------|
| `registries` | `Pick<AppRegistries, 'agent' \| 'tool'>` | 与生产同接口的注册表视图（`createToolRegistry` + `createAgentRegistry` 实例级工厂创建后 `hydrate`，查询方法全量可用：`getAgent` / `getAgentEntry` / `listAgents` / `asTool` / `resolveAgentTools` / `resolveSubAgents` / `get` / `list`），可整体塞 `ctx.registries` 桩 |
| `loadToolModule` | `(filePath, functionName) => Promise<ToolModule>` | 满足 `AgentDeps['loadToolModule']` 签名——registry 中的产物形式 `filePath` 已在内部转绝对路径，业务方直接拼进 deps，无需自己处理路径 |
| `resolveToolSchema` | `AgentDeps['resolveToolSchema']`（仅 `generated`） | 生产口径 schema 解析（zod.js → JSON Schema + safeParse 校验函数），实现即 `createToolSchemaResolver`（带 dist），free-form 时为 `undefined` |
| `resolveAgentInputSchema` | `AgentDeps['resolveAgentInputSchema']`（仅 `generated`） | 与 `resolveToolSchema` 同一实例（tool 入参与 agent 派发入参共用缓存），free-form 时为 `undefined` |
| `agentNames` | `string[]` | 扫描水合后的 agent 注册名清单（`@agent` 覆盖名生效后），测试按名取 core / 断言集合 |
| `toolNames` | `string[]` | 扫描水合后的 tool 最终名清单（`@tool` 覆盖名生效后） |
| `schemaDist` | `string` | 产物临时目录绝对路径（`free-form` 下含 tool handler 编译产物，`generated` 下另有 zod.js），调试可查看 |
| `close()` | `() => Promise<void>` | 清理产物临时目录。幂等（重复调用不重复清理） |

## 行为约定

- **扫描与水合同生产管线**：`scanAgents` / `scanTools`（零 import 扫描 + 字符集校验）→ `generateAgentArtifacts` / `generateToolArtifacts`（AST 增强 + 清单级校验）→ 实例级注册表工厂 `hydrate`。与 dev 启动的唯一差异是不写全局/不建 app——产物写到临时目录、水合到独立实例，对进程内单 app 强制零占用。
- **handler 装载走源码侧（自封性）**：创建时经 `collectRelativeImports` 收集 tool 源码的 src 内依赖闭包（相对 import + tsconfig paths 别名），`compileDevRoutes` 逐文件编译到临时目录——测试进程不要求先跑过 build。agent 源码不编译（声明式 agent 运行时不 import handler.js，人设走 `systemPromptFile` 的 readResource 直读、入参 schema 走 AST 管线的 zod.js）。
- **vitest 下模块加载走 Vite SSR pipeline**（与 `createTestServer` 同款）：`loadToolModule` 内部经 `importWithCacheBust`，识别 tsconfig paths 别名、`vi.mock` 在加载的 tool handler 内生效。前置条件同 `createTestServer`（`test.globals: true` 或显式挂 `globalThis.vi`）。
- **不带 LLM**：providers 恒由测试侧组装（假 LLM 经 `agent.run(input, { agent, provider })` 的 `options.provider` 注入，或 `createScriptLLM` 官方件）——这是配方不是机械，harness 不掺业务语义。
- **资源读取根不绑定**：agent 声明 `systemPromptFile` 时运行时经免传参 `readResource` 直读，读取根仍是测试配方（`createTestContext({ path: '/', resourcesDir })` 绑定，不建 app 不挂 ctx）——与生产同一函数同一形态，缺文件时 run 显式抛 `AgentError`，不会静默跑在空提示词上。
- **编译失败即创建失败**：tool 源码闭包编译错误在 `createAgentTestHarness` 调用时响亮抛错（带原始 cause）——构建期失败优于首次 tool 调用失败。
- **zod 实例同源**：`generated` 模式的 schema 解析与生成的 zod.js 产物用业务方安装的同一个 zod（主包 peerDependency），无双实例分裂。

## 示例

### 1. 基础流程测试（free-form）

```ts
import { describe, it, expect, afterAll } from 'vitest';
import { createAgentTestHarness } from '@faapi/faapi/testing';
import { createScriptLLM } from '@faapi/agent';
import { Agent } from '@faapi/agent';

const h = await createAgentTestHarness({ rootDir: process.cwd() });
afterAll(() => h.close());

it('researcher 声明的 tool 集合与生产一致', () => {
  expect(h.agentNames).toContain('researcher');
  const tools = h.registries.agent.resolveAgentTools('researcher');
  expect(tools.map((t) => t.name)).toContain('weather_getWeather');
});

it('真 reactLoop + 真工具 + 脚本假 LLM', async () => {
  const llm = createScriptLLM([
    { toolCalls: [{ name: 'weather_getWeather', arguments: { city: '北京' } }] },
    { content: '北京晴' },
  ]);
  const agent = new Agent({
    providers: new Map(),
    llms: {},
    rootDir: process.cwd(),
    getAgent: h.registries.agent.getAgent,
    getAgentEntry: h.registries.agent.getAgentEntry,
    getTool: h.registries.tool.get,
    resolveAgentTools: h.registries.agent.resolveAgentTools,
    resolveSubAgents: h.registries.agent.resolveSubAgents,
    loadToolModule: h.loadToolModule,
  });
  const result = await agent.run('北京天气', { agent: 'researcher', provider: llm });
  expect(result.messages.at(-1)?.content).toBe('北京晴');
  expect(llm.requests[0]!.tools?.map((t) => t.function.name)).toContain('weather_getWeather');
});
```

### 2. schema 校验同时被测（generated）

```ts
const h = await createAgentTestHarness({ rootDir: process.cwd(), schemaMode: 'generated' });

// deps 拼装 schema 解析（或省略——free-form 放行）
const agent = new Agent({
  /* ...同上... */
  resolveToolSchema: h.resolveToolSchema,
  resolveAgentInputSchema: h.resolveAgentInputSchema,
});

// 脚本给的坏入参 → 校验失败以 { error } 回灌 LLM（生产口径），流程测试锁住这一层
const llm = createScriptLLM([
  { toolCalls: [{ name: 'weather_getWeather', arguments: { city: 123 } }] },
  { content: 'done' },
]);
```

## 与其他测试方式对比

| 方式 | 依赖产物 | 真 reactLoop | 真注册表 | 单 app 占用 | 适用场景 |
|------|---------|-------------|---------|------------|---------|
| 手搓注册表桩 | 否 | ✅ | 否（漂移面） | 否 | （历史方式，已被本设施取代） |
| `createProdApp` + `Agent` | ✅（先 build） | ✅ | ✅ | **是** | 已有 build 产物的全链路验证 |
| **`createAgentTestHarness` + `Agent`** | **否（现场编译）** | **✅** | **✅（同管线）** | **否** | **agent 流程集成测试** |

## 局限性

| 局限 | 说明 |
|------|------|
| 不读 `faapi.config.ts` | agent 运行时配置（`maxTurns` / authHooks / llms）由测试组装 deps / `Agent` 构造参数显式给——配方不是机械 |
| 不加载插件 | `@faapi/agent` 插件的 handle 工厂不注册；测试直接 `new Agent(deps)`（deps 即 harness 返回的部分） |
| src 外依赖不编译 | 与 dev 按需编译同边界（outbase=src 语义限制）：tool handler import rootDir 下 src 外的本地文件会失败；node_modules 正常解析 |
| watch 不支持 | harness 是一次性快照（创建时扫描），测试中改源码不触发重新扫描——重建 harness 实例即可 |

## 相关模块

- [testServer.md](./testServer.md) - HTTP 层对位物（同款 mkdtemp + close 清理 + vitest 别名解析取舍）
- [injection/registries.md](./injection/registries.md) - 实例级注册表工厂（`createToolRegistry` / `createAgentRegistry` / `hydrate`）
- [agents/scanAgents.md](./agents/scanAgents.md) / [tools/scanTools.md](./tools/scanTools.md) - 扫描（零 import + 字符集校验）
- [cli/generateAgentArtifacts.md](./cli/generateAgentArtifacts.md) / [cli/generateToolArtifacts.md](./cli/generateToolArtifacts.md) - AST 增强 + zod.js 生成
- [loader/loadToolModule.md](./loader/loadToolModule.md) - tool handler 加载（harness 桥接的底层）
- [loader/toolSchemaResolver.md](./loader/toolSchemaResolver.md) - schema 解析工厂（`generated` 模式的实现）
- [cli/compileOnDemand.md](./cli/compileOnDemand.md) - 依赖闭包收集与按需编译（handler 源码侧装载的机制来源）
- `@faapi/agent` 的 `scriptLlm.md` - `createScriptLLM` 脚本假 LLM（配套官方件）
