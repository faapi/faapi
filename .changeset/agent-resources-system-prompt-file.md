---
'@faapi/faapi': minor
---

agent 全链路支持运行时资源目录，消除 taskCtx 不注入边界：

- agent config 新增 `systemPromptFile` 字段（相对产物 resources 目录的路径字面量，与 `systemPrompt` 互斥二选一必填）——运行时每次 run 读文件内容作为 system 消息，dev 改 prompt 文件经 watcher 增量复制后立即生效；`PluginContext` 新增 `resourcesDir`（`@faapi/agent` 自动注入 `AgentDeps`，业务插件也可用）
- `taskCtx.resourcesDir`：进程内与隔离 worker 两条执行路径均注入产物 resources 目录绝对路径（此前任务侧无资源定位入口）
- 修复 agent.md 文档滞后：自定义 `run` 的第二参实为完整请求 `FaapiContext`（`mod.run(args, ctx)`），文档此前写为仅 `args`
