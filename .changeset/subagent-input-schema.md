---
'@faapi/faapi': minor
'@faapi/agent': minor
---

feat(agent): agent-as-tool 派发工具改用显式单字段 input 入参 schema

sub-agent 工具（`agent.<name>`）暴露给 LLM 的 `function.parameters` 从无属性 `{ type: 'object' }` 改为显式入参约定：`{ type: 'object', properties: { input: { type: 'string', description } }, required: ['input'] }`。严格遵循 JSON schema 的模型（GLM 系列、OpenAI strict mode 等）对无属性 object 只会回空 `{}`，导致主控 agent 派发子代理时交接单（任务上下文）无法传递；宽松填参的模型不受影响。

配套变更：

- `AgentCore` 新增可选字段 `inputDescription`（文件型 agent 在 config 块声明，DB skill 直接填字段），作为该工具 `input` 字段的 schema description；未声明时用框架默认文案。声明了非字符串值在构建期抛 `SchemaExtractionError`。
- `executeSubAgent` 默认 reactLoop 路径：tool call args 恰为单字段 `{ input: <string> }` 时直传字符串作为子代理 user 消息（去 JSON 壳）；其余形状（宽松模型多传字段/传空对象/任意 JSON）保持 `JSON.stringify` 兜底，向后兼容。
- 自定义 `run` 函数始终接收原始 args 对象（默认 schema 下形状为 `{ input: '交接单' }`），建议业务方读 `args.input` 取交接单。
