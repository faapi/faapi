# resolveInjection

一句话概括：分析函数参数，决定需要注入什么内容。

## 为什么需要

传统方式参数顺序固定（query, context），不够灵活。新系统通过分析参数名，自动决定注入内容，让开发者只声明需要的参数。

## 使用场景

- 路由 handler 调用前分析参数
- 决定需要准备哪些注入值
- 提取类型信息用于校验
- 识别 `agent` / `agents` 参数名，交由 [injectParams](./injectParams.md) 注入 agent 元数据

## 注入类型映射（Phase 2.3 扩展）

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
| `agent` | agent | 默认 agent（Phase 2.4 实现注入值） |
| `agents` | agents | 所有已注册 agent 的元数据列表（Phase 2.3） |
| 其他 | unknown | 不注入（由注入器提供） |

`agent` / `agents` 注入类型在 Phase 2.3 添加到 `PARAM_TYPE_MAP`，识别参数名后由 [injectParams](./injectParams.md) 的内置注入处理：
- `agents` → 返回 `listAgents()`（[agentRegistry](./agentRegistry.md) 中所有 agent 元数据）
- `agent` → 返回 `undefined`（Phase 2.4 实现 `config.defaultAgent` 后增强，注入默认 agent 元数据）

Phase 3.x 的 `@faapi/agent` 插件通过注入器机制增强为 `AgentHandle`（含 `metadata` + 可调用 `run`），覆盖内置的元数据注入。

## 相关模块

- `injectParams.ts` - 使用分析结果执行注入
- `extractHandlerTypes.ts` - 类型提取
- `agentRegistry.ts` - agent 元数据来源（`listAgents`）
