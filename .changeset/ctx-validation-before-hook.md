---
"@faapi/faapi": patch
"@faapi/schema": patch
"@faapi/next": patch
"@faapi/mcp": patch
"@faapi/agent": patch
---

tool ctx 声明即校验提升到 `Agent.executeTool` 内 beforeToolCall 守卫之前：ctx 装配错误是编程/装配问题，不再流进业务钩子——钩子只面对合成正确的 ctx 做业务鉴权。仅真工具派发校验（sub-agent 派发名不受影响），schemaCache 与 executeToolCall 的二次校验共用实例缓存（二次校验保留为防御纵深）。
