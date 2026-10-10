# agentScope

一句话概括：执行作用域上下文——run/stream 全链上让业务任何深层（tool 内部的 DAO、审计层、成本分摊层）能读到「当前跑在哪个 agent、第几层」，`getAgentScope()` 只读。

## 为什么需要

框架执行期（reactLoop / executeSubAgent）内部精确知道「当前哪个 agent、第几层」，但业务深层拿不到：`AgentDeps.ctx` 是请求级的（一次 run 内不随派发变化），到不了 tool 内部的横切层。业务方为做归属（如 SQL 级查询归属到对话时间线）只能自建 AsyncLocalStorage 并靠监听 stream 事件手动 push/pop 模拟框架内部栈——正确性依赖「流式同轮工具串行」这个未承诺的实现细节，而非流式路径同轮工具是 `Promise.all` 并发（reactLoop.ts），并发派发下归属静默错乱。

框架在结构正确的位置（run/stream 入口 + sub 派发边界）维护作用域，业务只读取——这是相对业务自建 ALS 的核心增量：并发分支各自作用域由 ALS 结构保证，不依赖任何事件序假设。

## 使用场景

- **查询归属**：tool 内部 DAO 层按当前 agent/depth 标注 SQL 日志（第一个消费者：writer 的对话时间线 inner_query 归属）
- **审计 / 限流 / 成本分摊**：任何「需要知道当前执行在哪个 agent 上下文里」的横切层

业务拿作用域做什么完全是配方，框架不读不消费；不读 = 零行为变化（纯新增）。

## API

```ts
/** 当前执行作用域 */
interface AgentScope {
  /** 当前正在执行的 agent 注册名（根为 run 的 agent，派发中为 sub） */
  agentName: string;
  /** 递归深度，1 = 根 agent */
  depth: number;
}

/** 读取当前执行作用域；非 agent 执行链上（health-check/cron/普通 API）返回 undefined */
function getAgentScope(): AgentScope | undefined
```

无 options、无配置面——作用域由框架自动维护，业务只读（`runWithAgentScope` 是框架内部挂载点，不对外导出）。

## 语义细则

| 项 | 语义 |
| --- | --- |
| 覆盖 | run/stream 从入口到收尾全链，含全部 sub-agent 递归与每层的 tool 执行（tool handler 内任意调用深度可读，含 await 之后再读） |
| 并发 | 每个并发分支（同轮多 tool / 多 sub 派发，含非流式 `Promise.all` 路径）各自作用域，归属互不串 |
| 业务消费 | 只读；框架不读不消费——用途（归属/审计/分摊）是配方 |
| 非 agent 链 | `undefined`——含直调 `reactLoop` / `reactLoopStream`（不经 `Agent.run/stream`）的路径；业务侧自行静默跳过 |
| 与 tracing 的关系 | 正交——作用域是常开的轻量上下文（一个对象），tracing 是 opt-in 的明细事件，互不绑定 |
| 兼容 | 纯新增，未读取 = 零行为变化 |

## 实现要点（挂载点）

1. **挂载点在 `Agent.run` / `Agent.stream` 入口**：`buildLoopConfig` 成功后建 ALS store（scope = 当前 agent + `this.depth`）。sub 换栈不需要 `executeSubAgent` 单独处理——它统一委托 `subAgent.run()` / `subAgent.stream()`（子 Agent 实例自带 `depth+1` 与 sub 名），入口挂载即天然覆盖派发边界；派发前的校验段（深度防护 / 入参 schema 校验）运行在父作用域内，语义正确。
2. **ALS 与 async generator 的上下文语义**（实现关键）：generator 体内**不捕获创建时上下文**——体内段落随消费方每次 `next()` 调用的上下文执行。因此：
   - 非流式：`als.run(scope, () => reactLoop(...))` 直接生效——ALS 随 promise 链传播，同轮 `Promise.all` 并发分支各自继承；
   - 流式：逐次在作用域内驱动内层迭代器（`als.run(scope, () => iterator.next())` 循环转发 chunk），等价 `yield*` 且背压保持（仅消费方拉动时推进）。
3. **零开销口径**：store 仅在 run/stream 执行链上创建（每次 run 一个对象 + ALS 进出）；`getAgentScope()` 在无 store 时返回 `undefined`，业务侧静默跳过。非 agent 链零 ALS 参与。
4. **不读 = 零行为变化**：作用域是纯读取上下文，不改任何执行语义——不读它的既有测试与生产行为逐字节不变。

## 相关模块

- [agent.md](./agent.md) —— 挂载点所在：`Agent.run` / `Agent.stream` 入口建 store；`executeSubAgent` 经 sub Agent 实例的 run/stream 统一换栈
- [reactLoop.md](./reactLoop.md) —— 循环引擎本身不感知作用域（不经 Agent 直调 reactLoop 时无 scope）
- [agentHandle.md](./agentHandle.md) —— handler 侧 `agent.run/stream` 的入口类型，作用域随真实执行链生效
- [trace.md](./trace.md) —— 正交能力：opt-in 的明细事件 vs 常开轻量上下文
