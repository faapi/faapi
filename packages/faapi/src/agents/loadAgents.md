# loadAgents

一句话概括：agent 声明的启动期求值与校验——从定位清单（`faapi-agents.js`）逐个动态 import handler 产物模块、求值 `config` 导出、逐字段校验后水合到 agentRegistry。替代旧「构建期 AST 字面量提取 → 数据清单 → hydrate」链路。

## 为什么需要

agent 声明此前由构建期 TS AST 提取（该机制已整体下线）从源码字面量搬运进清单——单 agent config 只能是静态字面量：systemPrompt 仅静态串、description 仅 JSDoc 注释，业务动态需求（按 env/DB 切人设）被迫绕道全局面。

声明运行时化后，handler 模块在启动期被真实 import 执行——**单 agent 声明获得与全局声明面完全等价的动态能力**：`systemPrompt` 支持工厂函数（每次 run 求值）、`config` 可以是返回对象的函数（闭包/env 组装声明）。清单（[generateAgentArtifacts](../cli/generateAgentArtifacts.md)）因此降级为**定位清单**——只携带扫描期可定的静态事实（name / filePath / inputTypeName），声明数据不再进清单。

> **8.0 起 `reminders` 已整线移除**（框架不再提供提醒注入原语——声明面、`@faapi/agent` 的 `resolveReminders` 钩子与注入引擎一并删除）。声明 `reminders` 字段即撞本模块的白名单报错（迁移守卫）；进历史的动态注入块走 `resolveRootInput` / `resolveSubAgentInput`。

## 使用场景

- [createAppCore](../cli/createAppCore.md) 启动时经 `loadAndHydrateAgents` 调用（定位清单 → 求值 → 水合）
- [createDevApp](../cli/createDevApp.md) `reloadAgents` 热替换（`setLoadTimestamp` 已由外层更新）
- [agentTestHarness](../agentTestHarness.md) 进程内装载（与生产水合形态一致）

## 求值管线

```
SerializedAgentRecord[]（faapi-agents.js 定位清单）
    ↓ loadAndEvaluateAgents：逐个 importWithCacheBust(handler 产物)
    ↓ evaluateAgentDeclaration：求值 config 导出 + 逐字段校验（fail-fast）
AgentMetadata[]
    ↓ validateAgentDeclarations：重名 / agents 引用存在性
    ↓ registries.agent.hydrate(loaded)
agentRegistry（app 实例）
```

- 定位清单与 handler 产物模块**都**经 `importWithCacheBust`——dev reload 时外层 `setLoadTimestamp` 已更新，两个 import 都必须 bust，否则改 config 后 reload 拿到旧模块。handler 内部 import 的第三方/业务共享模块保持 Node 缓存（与路由 handler 现状一致，不扩大语义）
- dev 与 prod 同管线：dev 管线在求值前先 `ensureCompiled` 编译 agent 源码（[devCommand](../cli/devCommand.md)），宿主 import 编译产物——dev/prod 无第二套求值实现

## config 导出形态

handler.ts 的最小声明（`name` 由目录路径推导，不进 config；业务侧 `satisfies AgentDeclaration` 获得字段校验，类型见 [agentTypes](./agentTypes.md)）：

```ts
// src/agents/researcher/handler.ts
import type { AgentDeclaration } from '@faapi/faapi';

export const config = {
  description: '检索研究员',
  systemPrompt: () => `今天是 ${new Date().toISOString().slice(0, 10)}。${loadPersona()}`, // 工厂：每次 run 求值
  tools: ['web_search'],
  agents: ['writer'],
} satisfies AgentDeclaration;
```

- `config` 为对象字面量 → 直接采用；为函数 → 调用求值（须返回对象）——业务可用闭包/env 组装声明
- 检测到 `run` 导出 → 抛迁移错误（agent 统一为声明式执行，编排场景注册 tool——自定义 run 机制已整体移除）

## 校验规则（fail-fast，错误带定位）

单 agent 校验（`evaluateAgentDeclaration`）全部启动期抛错，错误信息统一带 `agent "<name>" (<filePath>)` 定位（filePath 为产物路径，可直接定位声明文件）：

| 场景 | 行为 |
|------|------|
| 检测到 `run` 导出 | 抛迁移错误（编排场景注册 tool） |
| 无 `config` 导出 | 抛错（含修复指引） |
| config 非 object / 数组 / 函数返回非对象 | 抛错（`got <describeValue>`） |
| 未知 config 字段 | 抛错（白名单：description / systemPrompt / systemPromptFile / tools / agents / maxTurns / inputDescription / vars——`reminders` 已移除，声明即撞本条报错）——静默忽略会掩盖拼写错误 |
| `systemPrompt` 与 `systemPromptFile` 同声明 | 抛错（互斥） |
| 两者都未声明 | 抛错（二选一必填——提示词是 agent 的最小必需声明） |
| `systemPrompt` 非 string/函数、`systemPromptFile` 非 string | 抛错 |
| `description` / `inputDescription` 非 string | 抛错 |
| `tools` / `agents` 非 string[]（元素混入非 string） | 抛错 |
| `maxTurns` 非有限正数 | 抛错 |
| `vars` 非平面对象 / 叶子非 string\|number\|boolean（嵌套不支持） | 抛错 |

清单级校验（`validateAgentDeclarations`）——跨 agent 组合才暴露的问题，静默水合会让注册表处于与声明意图不符的状态：

| 场景 | 行为 |
|------|------|
| agent 名重复（目录推导名撞名） | 抛错（hydrate 语义是后者覆盖前者，静默覆盖丢失 agent） |
| `agents` 引用了不存在的 agent 名 | 抛错（含可用清单——sub-agent 递归到运行时首次调用才失败会把错误推迟且不带启动上下文） |

`tools` 引用**不做**启动期校验——业务方 plugin 可在运行时注册额外 tool（`PluginContext.registries`），启动期校验会误报。

## API

| 导出 | 说明 |
| --- | --- |
| `evaluateAgentDeclaration(mod, locator)` | 求值单个 handler 模块的 `config` 导出为 `AgentMetadata`（含全部单 agent 校验）；`locator.inputTypeName` 为构建期 Input 检测的静态事实（类型编译期擦除，config 求值拿不到，只能从定位清单透传） |
| `validateAgentDeclarations(agents)` | 清单级校验（重名 / agents 引用存在性） |
| `loadAndEvaluateAgents(rootDir, dist, locators, registries)` | 完整装载：定位清单 → 逐个动态 import → 求值 → 校验 → hydrate，返回 `AgentMetadata[]`（供调用方日志/调试）；`registries` 为窄接口 `{ agent: { hydrate } }`（结构兼容 AppRegistries 与测试设施的实例级注册表） |

## 相关模块

- [agentTypes](./agentTypes.md) - `AgentDeclaration` / `AgentMetadata` / `SystemPromptFactory` 类型
- [scanAgents](./scanAgents.md) - 扫描产出定位清单（`AgentManifest[]`）
- [generateAgentArtifacts](../cli/generateAgentArtifacts.md) - 生成定位清单 `faapi-agents.js` + Input zod.js
- [manifestLoader](../cli/manifestLoader.md) - `loadAndHydrateAgents` 薄委托（消费方）
- [agentRegistry](../injection/agentRegistry.md) - 水合目标注册表
