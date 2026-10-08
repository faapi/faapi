# fallback.md — 降级禁令

**本框架不允许降级**（维护者决策，2026-10-08）：降级不区分严重程度——辅助信息丢失、可选能力缺席、物理约束受限都不构成降级理由。暂不支持的场景显式抛错或显式声明能力边界（fail fast + 可行动的错误信息）；确需例外的场景必须经维护者决策并在此留痕（场景 + 为什么必须降 + 降级后的实际行为 + 恢复条件），未留痕的降级按静默降级处理。

历史上留痕的降级场景已全部处置（改为显式失败，或删除该路径的能力），变更随对应版本 CHANGELOG 发布：

- 任务 payload schema 缺失跳过校验 → 构建期 Payload 声明必填（`type Payload = unknown` 显式豁免），运行时缺产物抛错
- 隔离任务错误 props 不可克隆丢弃 props → 任务显式失败（错误信息含原 name/message 与修复指引）
- 日志 fields 不可序列化降级提示文本 → 序列化对齐 `stringifyJson` 统一转换规则，循环引用等结构错误抛 `TypeError`
- 隔离任务日志 fields 不可克隆丢弃 fields → 按执行错误处理（与 progress 同语义）
- 隔离任务 `taskCtx.llm` 在 `@faapi/agent` 不可解析时 warn + undefined → 显式抛错（含安装指引）
- 中间件模块加载失败返回空 bundle → 显式抛错（命中路由请求 500，dev watcher 自愈）
- 插件加载失败 console.error 汇总后继续启动 → 聚合抛错（启动失败、listen 不执行）
- 任务 meta 字面量不可识别警告后忽略 → 构建期抛错
- 隔离任务 config 降级 JSON 快照（待决条目，2026-10-08 维护者决策收尾）→ **隔离任务不传 config**（`ctx.config` 为 `undefined`，进程配置不跨线程；数据经 payload 显式传入）——原 `safeConfig` 三级探测删除
