---
"@faapi/agent": minor
"@faapi/faapi": minor
---

`agent:input` 触发语义收敛为「用户输入轮」：仅当轮有新 user 输入（loop 首轮非空 input——根调用与子代理派发同口径；续跑携带新输入同属输入轮）时发射，每个 loop 恰好一次；工具轮 / 纯续跑轮（当轮无新 user 输入）不再发射，也不再虚构新增 user 消息承载订阅端片段。`agent:root-input` 口径不变（本就仅对非空 input 发射）。载荷形制不变（`{ depth, messages, ctx, addInput }`）。
