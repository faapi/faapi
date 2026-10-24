---
'@faapi/faapi': major
---

移除 agent config 的 `model` 字段——模型档位是调用侧决策，不再是 agent 的静态属性：

- handler config 里声明 `model`（任意值、任意形式，含字符串属性名 `'model'`）构建期抛 `SchemaExtractionError` 迁移错误，指引删除该声明
- `AgentCore` / `AgentMetadata` / `faapi-agents.js` 清单不再含 `model` 字段
- `agent.run/stream` 的 `options.model` 未传且无 `options.provider` 时抛 `AgentError`（原 agent 元数据 `config.model` 缺省 key fallback 删除）
- sub-agent 派发恒沿用父调用解析出的 provider 与 model（原「sub 元数据 model 优先」语义删除）

迁移：删除各 agent handler 里的 `model` 声明，模型档位改由调用侧显式传 `options.model`。
