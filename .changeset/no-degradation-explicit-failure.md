---
'@faapi/agent': minor
'@faapi/faapi': minor
---

feat: 框架禁降级——全部降级路径改为显式失败

维护者决策：框架不允许降级，降级不区分严重程度（辅助信息丢失、可选能力缺席、物理约束受限都不构成降级理由）；暂不支持的场景显式抛错（fail fast + 可行动的错误信息）。禁令已移入 AGENTS.md「5.6.4 禁止降级」，原项目根 `fallback.md` 台账（含隔离任务 config 待决条目）全部处置后删除。

破坏性变更（按 minor 发版留痕）：

- `llm.complete` 删除 `fallback` 选项（公开 API 删除）——传输失败（重试耗尽）恒抛 `LLMProviderError`，需要降级语义的调用方在业务侧 try/catch 自行实现（降级是业务决策，不由框架代劳）；`onFailure` 留痕钩子保留，自身抛错改为 `console.error` 留痕（原为静默忽略）

行为变更（旧降级行为改为显式失败）：

- 任务 payload：`run` 首参类型声明必填（缺失构建期抛错；确无入参契约显式声明 `type Payload = unknown` 生成恒通过的 `z.unknown()` schema）；运行时 zod.js 缺失/无 `*Schema` 导出抛错，不再静默放行
- 任务 meta：声明了字段但值非字面量（如 `timeoutMs: 30 * 60_000`）从「警告后忽略」改为构建期抛错；块注释行（`*` / `/*` 开头、终止符结尾）不再误报
- 隔离任务：错误 props 含不可克隆值从「丢弃 props 保底」改为任务显式失败（错误信息含原 name/message 与修复指引）；日志 fields 不可克隆从「丢弃 fields 输出 warning 标记」改为按执行错误处理（与 progress 同语义）；`agent.llms` 已配置但 `@faapi/agent` 不可解析从「warn + undefined」改为显式抛错（含安装指引）
- 中间件：模块加载/校验失败（import 失败、导出形态非法、项非函数）从「console.error + 空 bundle」改为显式抛错——命中路由请求 500（onError 可感知），dev watcher 修复后自愈；dev 按需编译失败同样冒泡
- 插件：任一插件失败从「console.error 汇总后继续启动」改为聚合抛错（`createAppBase` 启动失败、listen 不执行）；重复声明从「warn 跳过」改为记入失败
- 日志：fields 序列化对齐框架统一出口 `stringifyJson`（BigInt 原抛错、Map/Set/RegExp/NaN 原静默丢数据，现全部正确输出可逆原生表示）；循环引用等结构错误抛 `TypeError` 冒泡（「日志调用永不抛错」契约废除）；文件 sink 流错误（磁盘满等）从完全静默改为每流首次 `console.error` 留痕
- 钩子留痕：lifecycle `onError` / 任务 `onFailed` 自身抛错从静默吞掉改为 `console.error` 留痕
- 隔离任务 config：删除 `safeConfig` JSON 快照降级——**隔离任务（声明 timeoutMs）的 `ctx.config` 为 `undefined`**，worker 线程不接收进程配置（config 含函数字段不可结构化克隆，不做降级传递）；任务数据经 payload 显式传入（调用方 `tasks.enqueue(name, { db: ctx.config.db })`）。进程内任务不变：`ctx.config` 为活引用全量配置，类型从 `unknown` 收紧为 `FaapiContextConfig`（声明合并增强与 handler `ctx.config` 同源同型）。
- 上下文类型显式分开：新增 `IsolatedTaskContext`（隔离任务上下文，**无 config 字段**——访问即编译错误；registries/log/progress 的快照与克隆约束写在字段文档）。`TaskContext`（进程内）config 恢复必有——进程内恒有活引用。`TaskModule.run` 签名为两类型联合，业务按执行路径标注对应类型，边界编译期可见
