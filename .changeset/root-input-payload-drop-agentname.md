---
'@faapi/faapi': minor
---

agent 域事件载荷统一移除实体名（agent 名 / tool 名）字段——**载荷不再携带专属名订阅已编码的路由键**。

> 版本策略留痕：本变更按语义属破坏性（公开载荷接口字段删除，解构删除字段的 TS 代码会编译错），经维护者指示（2026-10-27 会话「发 7.x」）以 minor 随 7.x 线发布——迁移说明见文末表格。

`app.on` 的 agent 域事件均为「通用名 + `:<实体名>` 专属名」双订阅同一载荷对象，载荷里再带实体名与专属事件名冗余，业务方在「通用事件载荷读名字分流」与「订阅专属事件」两条等价路径之间产生使用困惑。移除后分工唯一：**按实体（agent/tool）路由订阅专属名事件（名字在事件名里）；通用名订阅是实体无关的横切处理（租户改写、审计打标、全量守卫等）**。

受影响载荷（均为公开导出接口）：

| 事件 | 移除字段 | 剩余载荷 |
| --- | --- | --- |
| `agent:root-input` | `agentName` | `{ input, ctx }` |
| `agent:input` | `agentName` | `{ depth, messages, ctx }` |
| `agent:before-tool-call` | `name` | `{ args, ctx, error? }` |
| `agent:after-tool-call` | `name` | `{ args, result, ctx }` |
| `agent:filter-tools` | `agentName` | `{ tools, ctx }` |
| `agent:system-prompt` | `agentName` | `{ prompt, ctx }` |
| `agent:sub-agent-context` | `subName` | `{ args, context?, ctx }` |

迁移：通用订阅里读实体名（`agentName` / `name` / `subName`）按实体分流的代码，改为按实体各订一个专属名事件（如 `getApp().on('agent:root-input:<name>', handler)`；事件名可用 `agentRootInputEventName` 等 helper 拼接）；只做横切处理、不关心实体名的通用订阅无需改动。
