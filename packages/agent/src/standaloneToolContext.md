# standaloneToolContext

一句话概括：`createStandaloneToolContext(overrides?)` 为无 app 编排场景（测试调用、编程式脚本）构造合规的 `AgentToolContext`——契约字段给诚实缺省，业务字段经 overrides 显式注入并**流型到返回类型**（构造漏传在调用点编译报错）。

## 为什么需要

`AgentDeps.ctx` 收紧为必填后，每一条 AgentDeps 装配路径都要提供契约 ctx：HTTP/任务路径由框架合成，但测试调用 tool、编程式 `new Agent(deps)`、插件 setup 的 baseDeps 占位没有 app 编排可依赖——手工拼 `{ tasks: ???, log: ???, signal: ??? }` 既啰嗦又容易造出假字段。本助手是这些场景的官方构造入口：缺省值诚实（tasks 桩调用即抛错并给修复指引，绝不静默假成功），业务身份字段显式声明。

## 使用场景

- 测试调用 tool（走真实分发管线）：`callTool(h, 'order_getOrder', args, createStandaloneToolContext({ currentUserId: 7 }))`——ctx 装配错误由声明即校验在测试现场响亮抛错；**直调 `mod.handler(input, ctx)` 不是受支持场景**（绕过校验，业务字段缺失静默执行）
- 测试组装 deps：`createAgentDeps({ registries: harness.registries, ctx: createStandaloneToolContext({ currentUserId: 7 }) })`
- 编程式脚本（无 HTTP 请求、无队列）组装 Agent
- `@faapi/agent` 插件 setup 的 baseDeps 占位（每次请求工厂以请求 ctx 覆盖）

## 缺省值

| 字段 | 缺省 | 语义 |
|------|------|------|
| `tasks` | 抛错桩（主包 `createThrowingTaskClient` 同源实现）——任意方法调用即抛错并给修复指引 | 测试/脚本环境没有任务队列，假队列会静默吞掉任务交互；显式失败让"漏注假体"第一时间暴露 |
| `log` | `createLogger('standalone')`（console 出口，框架缺省行为） | 无 app 管道可写，console 是框架缺省出口；测试可覆盖为静默实现 |
| `signal` | 新建 `AbortController` 的 signal（永不触发） | 无宿主生命周期可挂钩；需要取消语义时显式传入 |

overrides 浅合并到缺省之上，业务增强字段（currentUserId 等）与其他任意键直接落 ctx 顶层。

## 业务字段必填与类型流型

**官方形态：业务定义校验类型（纯数据字段），handler ctx 参数以交叉标注携带（需要框架字段时 `& AgentToolContext`）——运行时框架声明即校验（见主包 [agentToolContext](../../faapi/src/runtime/agentToolContext.md)），消费点零断言；本助手泛型流型在编译期辅助拦截构造漏传（运行时强制在真实分发管线，测试调用走 [callTool](./callTool.md)）。**

```ts
// 业务校验类型——纯数据字段（不要 extends AgentToolContext：构建期提取会因
// 框架字段类型语法抛 SchemaExtractionError，交叉标注是唯一的框架字段携带形态）
interface OrderCtx {
  currentUserId: number;
}

// 工具签名声明所需契约——消费点直接用，无 if throw
export async function getOrder(input: { orderId: string }, ctx: OrderCtx & AgentToolContext) {
  ctx.currentUserId; // number
  ctx.log.info('...'); // 框架字段类型在
}
```

构造返回类型随 overrides 流型（重载双签名），「构造不完全就不能调用」由**调用点结构检查**强制：

```ts
const ok: OrderCtx & AgentToolContext = createStandaloneToolContext({ currentUserId: 7 });
// 带实参重载：返回 AgentToolContext & { currentUserId: number } → 编译通过

const bad: OrderCtx & AgentToolContext = createStandaloneToolContext();
// 无实参重载：精确返回裸契约（AgentToolContext），缺 currentUserId → 编译报错
```

无实参路径必须是**非泛型精确返回**——泛型默认值 `Record<string, never>` 的索引签名会让缺字段检查穿透（`never` 对任何目标属性类型可赋，tsc 实测），故重载双签名：带实参走泛型流型、无实参走精确裸契约。显式空对象 `({})` 同样报缺字段。

字段类型传错的裁决在消费点：构造点流型（传 `'abc'` 流出 string），消费点子类型要求 number 时结构检查报错——构造点负责流型、调用点负责契约检查，分层不重复。

**不支持 `declare module` 增强**（`AgentToolContext` 刻意声明为 type alias 而非 interface，业务侧增强声明直接编译报错 TS2300，见主包 [agentToolContext](../../faapi/src/runtime/agentToolContext.md)）：业务字段是框架不认识的——增强开了交叉标注之外的第二条通道，语义分裂且「类型在、运行时路径依赖在场」的中间态靠自觉兜底。业务字段唯一通道是**业务自己的校验类型**：必填由运行时校验 + 本助手调用点结构检查裁决，路径依赖的可选读取面用可选字段表达（`chatNovelId?: number`）。

## 相关模块

- `../faapi/src/runtime/agentToolContext.ts` - 契约类型定义（主包持有，本包 type import）
- `./agentDeps.ts` - `createAgentDeps` 的 ctx 必填来源；插件 setup baseDeps 占位消费本助手
- `./scriptLlm.ts` - agent 流程测试的假 LLM，与本助手配套构成无 app 测试基建
