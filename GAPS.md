# GAPS — 遗留缺口清单

> 来源:writer 项目 agent 链路审查(2026-09-26)反推的框架侧缺口,逐项带证据与建议改法。

## GAP-1 sub-agent token usage 不冒泡,父 run 的 usage 只含主循环

**现状**:agent-as-tool 派发时,`executeSubAgent`(`packages/agent/src/agent.ts`)拿到子 agent 完整的 `ReactLoopResult`(含 `usage` / `turns`),但只返回 `result.content`(或 tracing 开启时的 `TracingToolResult`)——子循环的 usage 在这一行被丢弃。`reactLoop` 的 `usage` 只累加本循环自己的 `llm_call`(`packages/agent/src/reactLoop.md`「累积 usage(多轮 token 用量累加)」)。tracing 的 `subagent_call` 事件虽嵌套 sub-trace(含各层 usage),但 tracing 是 opt-in 默认关,不能作为用量台账的依赖前提。

**影响**:多 agent 场景下,业务方按 run 落用量台账会系统性低估——子代理循环才是 token 大头。实际案例:writer 的 llm_usage 表(writer@219ae10)只能按主循环口径落库,并在注释里写死「子代理是独立循环,usage 不含其 token(框架限制)」;拆书场景(主控派发 3 个 28 轮子代理/章)的逐章成本被显著低估,聚合端点的成本趋势失真。

**改法**(二选一,倾向 a):

- **a. `usage` 语义升级为整树累计**:`executeSubAgent` 把子 result 的 usage 累加进父循环的 usage 计数(`maxAgentDepth` 内多层递归逐层上卷,天然聚合)。优点是调用方零改动;代价是改变 `usage` 现有语义(「本次 run 主循环用量」→「整树用量」),需在 `agent.md` / `ReactLoopResult` 类型注释标注口径变化,并在 changelog 标注 breaking。
- **b. 保留 `usage` 主循环口径,新增聚合字段**:如 `ReactLoopResult.totalUsage`(整树累计)与流式 `done.totalUsage`,子 usage 逐层卷积;业务方按需取用,`usage` 消费方(writer 既有落库)不受影响。

**边界**:

- 自定义 `run` 的 sub-agent(handler 导出 `run` 函数)不走默认 reactLoop,无结构化子 usage 可卷——聚合只覆盖默认路径,文档需注明。
- `turns` 是否随 usage 同口径聚合,随所选方案一并对齐(倾向同口径聚合,或在 `totalTurns` 中体现)。

**验收**:两层派发场景(主控 → sub → sub-sub),父 run 的聚合 usage(或 totalUsage)= 全部 `llm_call` usage 之和;单测覆盖多层上卷与自定义 run 混合(自定义 run 子代理计 0)两条路径;writer 侧确认后可去掉「框架不冒泡」注释切换聚合口径。
