---
'@faapi/agent': minor
'@faapi/faapi': minor
---

tool 调用收口到真实分发管线：新增 `callTool` 测试辅助（agent 包），`createAgentTestHarness` 移除 `loadToolModule` 直调面（faapi 包）。背景：ctx 声明即校验的运行时门禁只在 `executeToolCall`（agent 派发唯一路径），历史测试姿势 `harness.loadToolModule(...)` + `mod.handler(input, ctx)` 完全绕过校验——`ToolModule.handler` 参数为 `unknown[]`（编译期流型检查失效），业务字段（如 `currentUserId`）缺失时 handler 拿到 `undefined` 静默执行，租户隔离在测试层穿底（测试绿但生产路径会拒绝）。与 HTTP 层对齐：路由测试走 `createTestServer` 真实管线，tool 测试走 `callTool` 真实分发管线。

- **新增 `callTool(harness, name, args, ctx)`**：经 `executeToolCall` 同一条生产分发链（input schema 校验 + ctx 声明即校验 + handler 执行）。ctx 装配错误（缺字段/错型）在调用 handler 前**响亮抛错**（与 `executeToolCall` 共用 `validateToolCtx` 单一实现；测试 ctx 构造问题属编程错误，不得以 `{ error }` 静默返回让测试假绿）；input 校验失败返回 `{ error }`（原样可断言）；handler 结果原样返回。free-form 模式显式抛错指引改用 `generated`（无 schema 可校验不静默放行）。
- **`AgentTestHarness` 接口收缩**：移除 `loadToolModule`（直调面）；新增只读 `rootDir`（`callTool` 桥接 loader 与解析 registry 产物形式相对 filePath 用）。组装 `AgentDeps` 用 `createAgentDeps`（自带 loader 桥接）或经 `@faapi/faapi/testing` 导出的 `loadToolModule` 显式桥接。**迁移**：原 `h.loadToolModule(fp, fn)` + `mod.handler(...)` 直调用例改为 `callTool(h, name, args, ctx)`——业务侧现存直调测试若 ctx 不完整会从静默通过变为响亮失败（fail-fast，正是本变更目的）。
- 无 ctx 声明的 tool 口径不变：ctx 原样透传不校验（与分发路径一致）。
