# extractAgentMetadata

一句话概括：从 agent handler.ts 源文件提取 agent 的 JSDoc 描述、`@agent` 覆盖名、config 块字段(systemPrompt / tools / agents / model / maxTurns)，产出完整的 `AgentMetadata` 结构供产物生成阶段消费。

## 为什么需要

`scanAgents` 只通过正则检测了 `config`/`run` 导出是否存在(Vite 风格零 import)，但生成 `faapi-agents.js` 清单还需要两类信息：

1. **JSDoc 描述 + `@agent` 覆盖名**——agent 名对 LLM 可见，描述让 LLM 理解 agent 用途。`@agent` 标签允许覆盖目录推导的默认名。
2. **config 块字段**——`systemPrompt`(系统提示词)、`tools`(agent 显式声明可用 tool 引用列表)、`agents`(可调用的其他 agent 列表)、`model`(LLM 模型)、`maxTurns`(最大对话轮数)。这些字段在运行时由 Agent 类/reactLoop 消费。

这些信息必须用 TypeScript AST 提取(JSDoc 和对象字面量在运行时被擦除)。本模块在 dev/build 启动时对每个 `AgentManifest` 调用一次，把路径推导字段(name/filePath/hasConfig/hasRun)与 AST 提取字段(description/config 块字段)合并为完整的 `AgentMetadata`，供 [generateAgentArtifacts](../cli/generateAgentArtifacts.md) 直接序列化。

与 [extractToolMetadata](./extractToolMetadata.md) 同构——一个从函数导出提取 JSDoc + 参数类型，一个从 config 导出提取 JSDoc + 配置块。

## 使用场景

- `faapi dev` / `faapi build` 启动时，`generateAgentArtifacts`(Phase 1.9) 对每个 `AgentManifest` 调 `createProgram` + `extractAgentMetadata`，产出 `AgentMetadata[]` 写入 `faapi-agents.js`
- watcher 热替换时重新调用(`invalidateProgramCache` 后重新提取)

## 提取规则

### JSDoc 来源

JSDoc 从哪个导出提取取决于 agent 的定义形式：

| agent 形式 | JSDoc 来源 |
|-----------|-----------|
| 有 `config` 导出 | `config` 的 JSDoc(写在 `export const config` 或 `export function config` 上方) |
| 无 `config`，有 `run` 导出 | `run` 的 JSDoc(写在 `export function run` 上方) |
| 都没有 | `undefined` |

> `config` 优先——它是 agent 的主定义块，`run` 是可选的实现函数。

### JSDoc 描述

从导出的 JSDoc 注释块提取 `comment` 字段(注释块内 `@tag` 之前的自由文本)：

| JSDoc 形式 | 提取的 description |
|-----------|-------------------|
| `/** 研究员 agent */` | `'研究员 agent'` |
| `/**\n * 研究员 agent\n * @agent researcher\n */` | `'研究员 agent'`(`@agent` 之前的首段) |
| `/** @agent researcher */`(无自由文本) | `undefined` |
| 无 JSDoc | `undefined` |

### `@agent` 覆盖名

JSDoc 中 `@agent <name>` 标签的值，覆盖目录推导的 `name`：

| JSDoc | 提取的覆盖名 | 最终 `AgentMetadata.name` |
|-------|------------|------------------------|
| `/** @agent researcher */` | `'researcher'` | `'researcher'` |
| `/** @agent {researcher} */` | `'researcher'`(去花括号) | `'researcher'` |
| `/** 描述 \n * @agent researcher */` | `'researcher'` | `'researcher'` |
| 无 `@agent` 标签 | `undefined` | 使用 `pathMeta.name`(目录推导值) |

与 `@tool` 覆盖名([extractToolMetadata](./extractToolMetadata.md))同构——去花括号、缺省回退。

### config 块字段

仅当 `hasConfig=true` 时提取。config 块有两种导出形式：

**1. 对象字面量(最常见)**：
```ts
export const config = {
  systemPrompt: 'You are a researcher',
  tools: ['weather.getWeather'],
  agents: ['coder'],
  model: 'gpt-4',
  maxTurns: 10,
};
```

**2. 函数返回对象**：
```ts
export function config() {
  return { systemPrompt: '...', model: 'gpt-4' };
}
```

两种形式都提取返回对象字面量的属性：

| 字段 | 期望类型 | 提取值 | 示例 |
|------|---------|--------|------|
| `systemPrompt` | `StringLiteral` | `string` | `'You are a researcher'` |
| `tools` | `ArrayLiteralExpression` 全 `StringLiteral` | `string[]` | `['weather.getWeather']` |
| `agents` | `ArrayLiteralExpression` 全 `StringLiteral` | `string[]` | `['coder']` |
| `model` | `StringLiteral` | `string` | `'gpt-4'` |
| `maxTurns` | `NumericLiteral` | `number` | `10` |

非字面量值(变量引用、模板字符串、Spread、非 StringLiteral 的数组元素)返回 `undefined`——AST 静态提取无法求值，这些字段在运行时由 faapi.config.ts 的 `agent` 配置块或默认值兜底。

字段全部可选——缺失的字段为 `undefined`，运行时按默认值处理(如 `maxTurns` 默认 10、`model` 默认 faapi.config.ts 的 `agent.defaultAgent.model`)。

## API

```ts
interface AgentMetadata {
  name: string;              // @agent 覆盖值 或 pathMeta.name
  description?: string;      // JSDoc 描述
  filePath: string;          // 从 pathMeta 透传
  hasConfig: boolean;        // 从 pathMeta 透传
  hasRun: boolean;           // 从 pathMeta 透传
  // config 块字段(仅 hasConfig=true 时有意义)
  systemPrompt?: string;
  tools?: string[];
  agents?: string[];         // 可调用的其他 agent 名
  model?: string;
  maxTurns?: number;
}

interface AgentPathMeta {
  name: string;              // 目录推导的 agent 名(如 "researcher")
  filePath: string;          // 源码相对路径(如 "src/agents/researcher/handler.ts")
  hasConfig: boolean;        // 是否导出 config 块
  hasRun: boolean;           // 是否导出 run 函数
}

function extractAgentMetadata(
  program: ts.Program,
  filePath: string,          // 源文件绝对路径(AST 用)
  pathMeta: AgentPathMeta,   // 路径推导的元数据(scanAgents 已计算)
): AgentMetadata | null      // null: 源文件不在 Program 中
```

## 关键行为

- **config 查找**支持两种导出形式：`export const config = {...}`(对象字面量)和 `export function config() { return {...} }`(函数返回对象)
- **JSDoc 查找**对箭头函数/函数表达式自动回溯到外层 `VariableStatement`(与 [extractToolMetadata](./extractToolMetadata.md) 同构)
- **config 块字段提取**仅处理字面量值——变量引用/Spread/模板字符串等非静态值返回 `undefined`
- **无 try/catch**——AST 异常向上传播，依赖调用方处理
- **不调用 `extractTypeInfo`**——agent 无输入参数 schema(tool 有，agent 无——agent 输入是自由文本 prompt，由 reactLoop 传递给 LLM)

## 相关模块

- [scanAgents](../agents/scanAgents.md) - 产出 `AgentManifest`(含 hasConfig/hasRun)，供本模块的 `pathMeta` 来源
- [agentTypes](../agents/agentTypes.md) - `AgentManifest` 类型定义
- [createProgram](./createProgram.md) - 创建 TypeScript Program
- [extractToolMetadata](./extractToolMetadata.md) - tool 元数据提取(对称设计参考)
- [generateAgentArtifacts](../cli/generateAgentArtifacts.md) - 下游消费 `AgentMetadata[]` 生成 `faapi-agents.js`(Phase 1.9)
