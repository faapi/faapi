# traceId

一句话概括:每次 `agent.run()` / `agent.stream()` 自动生成的**层级追踪 ID**——12 位十六进制段链式拼接(子 ID = 父完整 ID + `.` + 新段),注入 system prompt 末尾,并在结果上暴露,让 LLM 侧与业务侧日志按同一 ID 关联。

## 为什么需要

- 现有 [trace](./trace.md)(`enableTracing`)只在显式开启时可用,且不进 LLM 视野——排查「LLM 这轮答了什么」与「服务端 tool/日志执行了什么」缺一个天然关联键
- LLM 网关/模型服务侧的请求日志只有 provider 层信息,没有 agent 调用树概念——traceId 注入 system prompt 后,从 LLM 侧日志也能还原所属调用树
- sub-agent 多层派发后,各层输入输出分散在多层日志里;链式 ID 按前缀即可聚合同一次根调用的全部层级

## 使用场景

- **生产日志关联**:`result.traceId` 写业务日志;LLM 网关日志从 system prompt 读出同一 ID,两侧按 ID 对账
- **调用树聚合**:子 ID 以父完整 ID 为前缀,`startsWith(parentTraceId)` 即筛出整棵子树
- **跨服务串联**:`agent.run(input, { agent, traceId: ctx.requestId })` 把 agent 调用树挂到 HTTP 请求链路(显式 ID 优先级最高,如全局关闭也生效)

## 设计

### 生成规则

- **每段** = `crypto.randomUUID()` 去连字符后前 12 位十六进制(48 bit)。不用 8 位:32 bit 在日均百万级 trace 下按生日碰撞一天内即撞;48 bit 同规模约 10⁻⁴/天
- **根 agent**(每次 run/stream):自动生成根段(如 `3f2504e0a9b8`)
- **sub-agent 派发**:子 ID = `父完整ID.新段`——完整链式,深层自然成链:

  ```
  根:   3f2504e0a9b8
  子:   3f2504e0a9b8.5e4d3c2b1a09
  孙:   3f2504e0a9b8.5e4d3c2b1a09.7c6b5a49
  ```
- **显式指定**:`options.traceId` 原样作为本次调用 ID(根调用即根 ID;子链由框架在其后续拼),优先级高于全局开关
- **开关**:`config.agent.traceId: false` 整体关闭(不生成、不注入、结果无字段,逐字节回到现状);默认 `true`

### 注入提示词

- **位置**:最终 system 消息**末尾**——在 `agent:system-prompt` 事件改写结果与 `subAgentContextBlock` 之后由框架统一追加,不经过事件装饰(框架级元数据不参与应用层装饰)
- **默认模板**(英文,中性元数据措辞):

  ```
  [trace] trace_id={traceId} (internal observability id — do not mention it in your reply, and do not let it affect your answer)
  ```
- **自定义**:`config.agent.traceIdTemplate` 覆盖,`{traceId}` 占位符替换;模板不含 `{traceId}` 时抛 `AgentError`(fail fast——静默渲染出无 ID 的 trace 块是配置错误)
- **两个不注入场景**(最小影响原则):
  - 本次 run 构造的最终 system 消息为空(agent 无 systemPrompt)——不凭空多出一条只含元数据的 system 消息
  - 续跑(`options.messages`)历史自带 system 消息——`initLoopMessages` 既有语义下本次 systemPrompt 不被采用,历史不被改写、不重复注入(历史内是旧 ID 或无);本次 traceId 仍在结果暴露

### 不影响 LLM 调用结果的保障

- **追加不改写**:业务 prompt 原样保留,trace 块固定在末尾单行
- **中性措辞**:单行元数据 + 明确指示忽略,不构成任务指令
- **可整体关闭**:`config.agent.traceId: false`
- **结果只增可选字段**:`ReactLoopResult.traceId` / 流式 `done.traceId` / `AgentTrace.traceId`
- **诚实边界**:任何提示词注入都无法 100% 保证对生成零影响,以上把影响压到最低;要绝对零影响就全局关闭,用结果字段做追踪

### 结果暴露

| 位置 | 字段 | 条件 |
| --- | --- | --- |
| `ReactLoopResult.traceId` | 本次调用完整 ID | 非流式,traceId 启用时 |
| `ReactLoopStreamChunk.done.traceId` | 本次调用完整 ID | 流式,traceId 启用时 |
| `AgentTrace.traceId` | 同上(enableTracing 结构内) | `enableTracing=true`;sub-trace 嵌套自动携带子链 ID |

`executeSubAgent` 把子 ID 经 `subOptions.traceId` 传给子 Agent——子循环实际使用的 ID 与父侧包装的 `SubAgentToolResult.trace.traceId` 一致。

## 限制

- 链式 ID 长度随深度线性增长(每层 +13 字符);`maxAgentDepth` 默认 3,典型链 ≤ 40 字符
- 12 位十六进制段是进程内随机,**非全局强唯一**;跨服务强唯一用 `options.traceId` 传业务 ID(如 `ctx.requestId`)
- 注入只发生在「本次 run 构造 system 消息」时;续跑历史自带 system 的场景,历史内是旧 ID——新 ID 看结果字段
- [lightComplete](./lightComplete.md)(轻量一次性补全)不生成 traceId——非 agent 循环,无调用树

## 相关模块

- [trace](./trace.md) — `AgentTrace.traceId` 字段,sub-trace 嵌套携带
- [agent](./agent.md) — `buildLoopConfig` 解析 traceId 与注入;`executeSubAgent` 链式拼接并传递
- [agentHandle](./agentHandle.md) — `AgentRunOptions.traceId` 显式指定
- [reactLoop](./reactLoop.md) — `ReactLoopResult.traceId` / `done.traceId` 字段(Agent 层填充,reactLoop 不感知)
- [authHooks](./authHooks.md) — 同为 `AgentRuntimeConfig` 配置面,`traceId` / `traceIdTemplate` 与之平级
- AGENTS.md「agent 子系统全局配置」— `config.agent.traceId` / `traceIdTemplate` 配置入口
