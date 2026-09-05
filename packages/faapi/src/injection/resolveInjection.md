# resolveInjection

一句话概括：分析函数参数，决定需要注入什么内容。

## 为什么需要

传统方式参数顺序固定（query, context），不够灵活。新系统通过分析参数名，自动决定注入内容，让开发者只声明需要的参数。

## 使用场景

- 路由 handler 调用前分析参数
- 决定需要准备哪些注入值
- 提取类型信息用于校验
- 识别 `agent` / `agents` 参数名，交由 [injectParams](./injectParams.md) 注入 agent handle / 元数据列表

## 按函数引用缓存

`resolveInjection` 位于每请求热路径上（`invokeHandler` → `injectParamsAsync` → `resolveInjection`），
而参数分析依赖 `fn.toString()` + TypeScript 完整词法/语法解析，单次成本在数百微秒量级。

handler 函数在路由模块加载后引用稳定（ESM import 同一模块返回同一函数实例），参数列表在进程
生命周期内不会变化，因此分析结果按函数引用用 `WeakMap` 缓存：同一函数只解析一次，后续请求直接
命中。`WeakMap` 以函数为弱键，dev 热替换加载新模块后旧函数不再被引用即可被 GC，无需手动失效。

调用方拿到的是缓存的同一数组引用，**不得就地修改返回值**。

## 注入类型映射

| 参数名 | 注入类型 | 说明 |
| --- | --- | --- |
| `query` / `Query` | query | URL 查询参数 |
| `body` / `Body` | body | 请求体（JSON） |
| `form` / `Form` | form | form-urlencoded body |
| `params` | params | 动态路由参数 |
| `headers` | headers | 请求头 |
| `context` / `ctx` | context | FaapiContext |
| `cookies` | cookies | Cookie 对象 |
| `ip` | ip | 客户端 IP |
| `ua` | ua | User-Agent |
| `files` | files | multipart 文件列表 |
| `fields` | fields | multipart 表单字段 |
| `agent` | agent | 默认 agent 的 `AgentHandle`（由 [agentHandle](./agentHandle.md) 工厂注入） |
| `agents` | agents | 所有已注册 agent 的 LLM 可见元数据列表（`AgentCore[]`） |
| 其他 | unknown | 不注入（由注入器提供） |

`agent` / `agents` 注入类型在 `PARAM_TYPE_MAP` 中映射，识别参数名后由 [injectParams](./injectParams.md) 的内置注入处理：
- `agents` → 返回 `listAgents()`（[agentRegistry](./agentRegistry.md) 中所有 agent 的 `AgentCore[]`，合并文件型 + DB skill）
- `agent` → 返回 `getAgentHandle(ctx)`（通过 [agentHandle](./agentHandle.md) 工厂机制注入 `AgentHandle`，含可调用 `run`/`stream`/`asTool`）

`@faapi/agent` 插件在 setup 时调 `registerAgentHandleFactory` 注册工厂,工厂在每次请求时构造 [Agent](../../agent/src/agent.md) 实例作为 `AgentHandle` 返回。核心提供注册点,插件提供工厂,不通过注入器机制。

## 相关模块

- `injectParams.ts` - 使用分析结果执行注入
- `extractHandlerTypes.ts` - 类型提取
- `agentRegistry.ts` - agent 元数据来源（`listAgents`）
