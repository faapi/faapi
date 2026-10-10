---
'@faapi/faapi': minor
'@faapi/agent': minor
---

新增 agent 流程测试设施 `createAgentTestHarness`（`@faapi/faapi/testing` 导出）与官方脚本假 LLM `createScriptLLM`（`@faapi/agent` 导出）——agent 流程测试（真 reactLoop + 真工具 + 假 LLM）不再需要每项目手搓注册表桩。

- `createAgentTestHarness({ rootDir, schemaMode? })`：测试进程内扫描 agent/tool 源码（与 dev 启动同管线，`@agent`/`@tool` 覆盖名生效），现场编译 tool 源码闭包到临时目录（不依赖 build 产物），水合出与生产同接口的注册表视图（`registries`）+ 可拼装 `AgentDeps` 的 `loadToolModule` 桥接 + `agentNames`/`toolNames` 清单；`close()` 幂等清理。不建 app——单进程单 app 零占用
- `schemaMode: 'generated'`（默认 `'free-form'`）现场生成 zod.js 并按生产口径校验工具/派发入参（harness 直接提供 `resolveToolSchema` / `resolveAgentInputSchema`）
- `createScriptLLM(turns)`：按序回放预设回合、快照每轮完整请求、脚本用尽再被调用即抛错——作 `agent.run(input, { provider })` 注入，子代理递归共享同一游标
- 配套内部迁移（对业务方导入路径无影响）：`createToolSchemaResolver` 与 `ToolSchemaResolution` 类型从 `@faapi/agent` 下沉主包 loader 域（zod peer 同源，`@faapi/agent` re-export 兼容）；`loadToolSchema` / `getToolSchemaPath` / `createToolSchemaResolver` 新增可选 `dist` 参数（显式产物目录，缺省走 dev on demand / `FAAPI_DIST` 全局解析，行为不变）；`generateAgentArtifacts` 新增 `skipSchema` 选项（仅供测试设施使用，dev/build 管线不传）
