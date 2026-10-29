# agentTypes

一句话概括：agent 子系统的核心类型定义——`AgentManifest`（定位清单条目）、`AgentCore`（LLM 可见声明字段）、`AgentMetadata`（完整元数据）、`AgentDeclaration`（handler.ts `config` 导出契约）与 `SystemPromptFactory`。

## 为什么需要

agent 层多个模块（扫描、生成产物、求值装载、注册表、`@faapi/agent` 运行时）共享同一套类型定义。集中定义避免循环依赖和类型不一致。与 [toolTypes](../tools/toolTypes.md) 对称。

## 使用场景

- `scanAgents` 返回 `AgentManifest[]`（定位清单）
- `loadAgents` 求值产出 `AgentMetadata[]`（[loadAgents](./loadAgents.md)）
- `agentRegistry` 持有 `AgentMetadata[]`，查询面按 Core/Entry 双层暴露（[agentRegistry](../injection/agentRegistry.md)）
- 业务 handler.ts `export const config = {...} satisfies AgentDeclaration` 获得字段校验
- `@faapi/agent` 的 `Agent` 类、`asTool` 包装、DB-driven skill 都消费 `AgentCore`

## AgentManifest（定位清单条目）

```ts
export interface AgentManifest {
  name: string;     // agent 名（目录路径推导，如 researcher）
  filePath: string; // 源码相对路径（如 src/agents/researcher/handler.ts）
}
export type AgentManifestList = AgentManifest[];
```

由 [scanAgents](./scanAgents.md) 扫描文件系统生成，与 [ToolManifest](../tools/toolTypes.md) 对称——一个目录一个 agent，handler.ts 导出 `config` 块。agent 声明运行时化后清单降级为**定位清单**：只携带扫描期可定的静态事实，声明数据由启动期求值获得（`SerializedAgentRecord` 额外携带 `inputTypeName`——类型编译期擦除，只能由构建期检测提供，见 [generateAgentArtifacts](../cli/generateAgentArtifacts.md)）。

agent 为声明式执行（config + 默认 reactLoop）；handler 的 run 导出不被读取（编排场景注册 tool）。

## AgentCore（LLM 可见核心字段）

描述"agent 是什么"——LLM 真正需要消费的字段，不含声明文件定位信息。文件型 agent 与 DB-driven skill 都实现此接口（skill 无源文件，由业务方 plugin 从 DB 字段映射即可）。

```ts
export type SystemPromptFactory = () => string | Promise<string>;

export interface AgentCore {
  name: string;
  description?: string;                            // config.description 声明
  systemPrompt?: string | SystemPromptFactory;     // 与 systemPromptFile 互斥（二选一必填）
  systemPromptFile?: string;                       // 相对产物 resources 目录
  tools?: string[];                                // 注册时静态求值（拓扑数据）
  agents?: string[];                               // 启动期校验引用存在性
  maxTurns?: number;                               // 有限正数
  inputDescription?: string;                       // agent-as-tool 派发交接单说明
  vars?: Record<string, string | number | boolean>;// 注册时求值的静态平面对象
}
```

**字段求值时机**（启动期运行时求值语义）：

- `systemPrompt` 工厂函数——**每次 run** 求值，与 `systemPromptFile`「每次 run 读文件」语义对齐：按 env/DB 等运行时状态切换人设。工厂返回非 string 在 run 期抛 `AgentError`（启动期无法验证返回类型）
- `tools` / `agents` / `vars` / `maxTurns` / `description` / `inputDescription`——**启动期注册时一次求值**，仅接受静态值（注册表拓扑数据）

systemPrompt 三来源统一管线：内联串 / 文件 / 函数 → vars 渲染 → `agent:system-prompt` 事件（见 `@faapi/agent` 的 [agent.md](../../../agent/src/agent.md)）。

## AgentMetadata（文件型 agent 完整元数据）

```ts
export interface AgentMetadata extends AgentCore {
  filePath: string;          // 声明文件定位（产物形式，如 dist/agents/researcher/handler.js）
  inputTypeName?: string;    // 'Input'——构建期正则检测到顶层 Input 类型导出时声明
}
```

- `filePath`——声明文件定位（启动日志 / 清单可观测性用）；DB-driven skill 无源文件不实现此接口
- `inputTypeName`——`@faapi/agent` sub-agent 富 schema 派发的运行时判据：声明时派发该 agent 用富 JSON Schema 替代默认单字段 `input` 交接单并在执行前校验（zod.js 由 [generateAgentArtifacts](../cli/generateAgentArtifacts.md) 生成）；未声明派发行为不变（完全向后兼容）。类型编译期擦除，运行时不可反射——只能由定位清单携带

由 [loadAgents](./loadAgents.md) 从定位清单逐个动态 import handler 模块求值 `config` 导出产出。

## AgentDeclaration（handler.ts config 导出契约）

与 `AgentCore` 字段一致（仅少 `name`——由目录路径推导），业务侧 `satisfies AgentDeclaration` 获得编译期字段校验；运行时校验（白名单 / 互斥必填 / 元素类型）由 [loadAgents](./loadAgents.md) 启动期执行。

```ts
// src/agents/researcher/handler.ts
export const config = {
  description: '检索研究员',
  systemPrompt: '你是检索研究员',
  tools: ['web_search'],
} satisfies AgentDeclaration;
```

## 相关模块

- [scanAgents](./scanAgents.md) - 生成 `AgentManifest[]`（定位清单）
- [loadAgents](./loadAgents.md) - 求值 `config` 导出产出 `AgentMetadata[]`（含 `run` 导出检测）
- [generateAgentArtifacts](../cli/generateAgentArtifacts.md) - 定位清单 `faapi-agents.js` + Input 检测/zod.js
- [agentRegistry](../injection/agentRegistry.md) - 运行时 agent 注册表（Core/Entry 双查询）
