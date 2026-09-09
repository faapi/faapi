# extractAgentMetadata

一句话概括：从 agent handler.ts 源文件提取 agent 的 JSDoc 描述、`@agent` 覆盖名、config 块字段(systemPrompt / tools / agents / model / maxTurns)，产出完整的 `AgentMetadata`(继承 `AgentCore` + 代码加载细节)供产物生成阶段消费。

## 为什么需要

`scanAgents` 只通过正则检测了 `run` 导出是否存在(Vite 风格零 import)，但生成 `faapi-agents.js` 清单还需要两类信息：

1. **JSDoc 描述 + `@agent` 覆盖名**——agent 名对 LLM 可见，描述让 LLM 理解 agent 用途。`@agent` 标签允许覆盖目录推导的默认名。
2. **config 块字段**——`systemPrompt`(系统提示词)、`tools`(agent 显式声明可用 tool 引用列表)、`agents`(可调用的其他 agent 列表)、`model`(LLM 模型)、`maxTurns`(最大对话轮数)。这些字段在运行时由 Agent 类/reactLoop 消费。

这些信息必须用 TypeScript AST 提取(JSDoc 和对象字面量在运行时被擦除)。本模块在 dev/build 启动时对每个 `AgentManifest` 调用一次，把路径推导字段(name/filePath/hasRun)与 AST 提取字段(description/config 块字段)合并为完整的 `AgentMetadata`，供 [generateAgentArtifacts](../cli/generateAgentArtifacts.md) 直接序列化。

## Core / Metadata 分层

`AgentCore` 描述 LLM 可见字段(不含代码加载细节)，`AgentMetadata` 继承 `AgentCore` 额外含 `filePath` / `hasRun`：

- **`AgentCore`** —— `name` / `description` / `systemPrompt` / `tools` / `agents` / `model` / `maxTurns`。文件型 agent 与 DB-driven skill 都实现此接口。`agentRegistry.getAgent` 返回此类型。
- **`AgentMetadata extends AgentCore`** —— 额外含 `filePath`(加载 handler.js 用) / `hasRun`(是否导出 `run` 函数)。仅文件型 agent 实现。`agentRegistry.getAgentEntry` 返回此类型。

DB-driven skill 不实现 `AgentMetadata`(无源文件，无需 `loadAgentModule`)，只实现 `AgentCore` 存入 `skillRegistry`。

与 [extractToolMetadata](./extractToolMetadata.md) 的 `ToolCore` / `ToolMetadata` 分层同构。

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
>
> 注:`scanAgents` 不再检测 `config` 导出(只检测 `run`),但 `extractAgentMetadata` 在 AST 阶段仍会查找 config 导出(用于提取 JSDoc 描述 + config 块字段)。

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

从 config 导出的对象字面量提取(无论 `scanAgents` 是否检测到 config 导出,AST 阶段都会查找)。config 块有两种导出形式：

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
| `systemPrompt` | `StringLiteral` / `NoSubstitutionTemplateLiteral` / 其 `+` 拼接 | `string` | `'You are a researcher'`、`` `You are a researcher` ``、`'You are' + ' a researcher'` |
| `tools` | `ArrayLiteralExpression` 全元素为字符串字面量 / 无插值模板字符串 / 其 `+` 拼接 | `string[]` | `['weather.getWeather']`、`['weather' + '.getWeather']` |
| `agents` | `ArrayLiteralExpression` 全元素为字符串字面量 / 无插值模板字符串 / 其 `+` 拼接 | `string[]` | `['coder']` |
| `model` | `StringLiteral` / `NoSubstitutionTemplateLiteral` / 其 `+` 拼接 | `string` | `'gpt-4'`、`'gpt' + '-4'` |
| `maxTurns` | `NumericLiteral` | `number` | `10` |

无插值模板字符串(`NoSubstitutionTemplateLiteral`)语义等价于字符串字面量(多行分析人设的常见写法)，与 `StringLiteral` 同等提取。此外，字符串字面量之间用 `+` 拼接的多行写法(`'a' +\n 'b' + 'c'`)静态可求值，同样接受——拼接两侧递归求值，链式拼接按左结合自然展开，求值结果与 JS 运行时语义一致。拼接中混入无法静态求值为字符串的操作数(变量引用、含插值模板字符串、数字等)或使用非 `+` 运算符，仍视为提取失败抛错。

### 声明但提取失败 / systemPrompt 缺失 → 构建期报错

config 字段缺失与提取失败是两种语义，处理方式不同：

| 场景 | 行为 |
|------|------|
| `systemPrompt` 未声明(无 config 导出、config 无 return 对象、config 里没有该 key) | 抛 `SchemaExtractionError`——**agent 不能没有提示词**，人设是 agent 的必要组成 |
| 其他字段(tools/agents/model/maxTurns)未声明 | `undefined`，合法缺省，运行时按默认值处理 |
| 任意字段声明了但值提取失败(变量引用、含插值模板字符串、拼接混入数字/变量、混合类型数组元素、非数字字面量等) | 抛 `SchemaExtractionError`(带 file:line:column)，`faapi build` 直接失败，dev watcher 输出错误 |
| config 里声明了未知字段(如拼写错误 `maxTurn`) | 抛 `SchemaExtractionError`——框架不读的字段几乎必然是拼写错误或误解，静默忽略后运行时按默认值跑，与声明意图不符 |
| config 用了不支持的属性形式(computed 名、shorthand、方法) | 抛 `SchemaExtractionError` |
| 声明了 `config` 但形式不支持(`export const config = someVar`、函数/箭头函数无 return 对象字面量) | 抛 `SchemaExtractionError`，提示支持的导出形式 |

理由："声明了却提取不出"是确定的构建错误——静默降级为 `undefined` 后，运行时与"合法地未声明"不可区分(`reactLoop` 对 `undefined` systemPrompt 是正常路径)，agent 人设整体失效且端到端无任何告警。与 schema 类型提取的原则一致(AST 暂不支持的语法直接抛错，不降级)。

`systemPrompt` 进一步收紧为**必填**：提示词定义 agent 人设与输出格式约定，无提示词的 agent 不是合法的文件型 agent(JSDoc `description` 只是 LLM 可见的用途说明，不构成提示词)。约束加在文件型 agent 的构建期——DB-driven skill 不经过此链路，`AgentCore.systemPrompt` 类型保持可选，由业务方 plugin 自治。

`SpreadAssignment`(`...other`)跳过不报错——它不声明任何具名字段，无法静态归属；但 spread 提供不了 `systemPrompt` 时同样触发缺失报错。

除 `systemPrompt` 外的字段全部可选——未声明的字段为 `undefined`，运行时按默认值处理(如 `maxTurns` 默认 10、`model` 缺省时由调用方 `agent.run(input, { model })` 显式指定或作为缺省 key 参与 llms 解析)。

## API

```ts
// LLM 可见核心字段(文件型 agent 与 DB-driven skill 都实现)
interface AgentCore {
  name: string;              // @agent 覆盖值 或 pathMeta.name
  description?: string;      // JSDoc 描述(用途说明,不构成提示词)
  systemPrompt?: string;     // 系统提示词;文件型 agent 必填(构建期校验),DB skill 由业务方自治
  tools?: string[];          // agent 显式声明可用 tool 引用列表
  agents?: string[];         // 可调用的其他 agent 名
  model?: string;            // LLM 模型名
  maxTurns?: number;         // 最大对话轮数
}

// 文件型 agent 完整元数据(继承 AgentCore + 代码加载细节)
interface AgentMetadata extends AgentCore {
  filePath: string;          // 从 pathMeta 透传,loadAgentModule 加载 handler.js 用
  hasRun: boolean;           // 从 pathMeta 透传,是否导出 run 函数
}

// 路径推导的元数据(scanAgents 产出)
interface AgentPathMeta {
  name: string;              // 目录推导的 agent 名(如 "researcher")
  filePath: string;          // 源码相对路径(如 "src/agents/researcher/handler.ts")
  hasRun: boolean;            // 是否导出 run 函数
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
- **config 块字段提取**仅处理字面量值——无插值模板字符串与字符串字面量同等提取，静态可求值的 `+` 字符串拼接同样接受(含数组元素)；声明了字段但值提取失败(变量引用/含插值模板字符串/拼接混入数字/混合数组元素等)抛 `SchemaExtractionError`，不静默降级
- **systemPrompt 必填**——文件型 agent 未声明(无 config/config 无 return 对象/config 缺该 key)抛 `SchemaExtractionError`，提示词是 agent 的必要组成
- **无 try/catch**——AST 异常向上传播，依赖调用方处理
- **不调用 `extractTypeInfo`**——agent 无输入参数 schema(tool 有，agent 无——agent 输入是自由文本 prompt，由 reactLoop 传递给 LLM)

## 相关模块

- [jsDocMetadata.ts](./jsDocMetadata.md) - JSDoc 工具函数（hasExportModifier / getJSDocFromNode / extractDescription / @tag 覆盖名提取，统一来源）

- [scanAgents](../agents/scanAgents.md) - 产出 `AgentManifest`(含 hasRun)，供本模块的 `pathMeta` 来源
- [agentTypes](../agents/agentTypes.md) - `AgentManifest` 类型定义
- [createProgram](./createProgram.md) - 创建 TypeScript Program
- [extractToolMetadata](./extractToolMetadata.md) - tool 元数据提取(对称设计参考,同样有 ToolCore/ToolMetadata 分层)
- [agentRegistry](../injection/agentRegistry.md) - `getAgent` 返回 `AgentCore`,`getAgentEntry` 返回 `AgentMetadata`
- [generateAgentArtifacts](../cli/generateAgentArtifacts.md) - 下游消费 `AgentMetadata[]` 生成 `faapi-agents.js`(Phase 1.9)
