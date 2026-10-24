---
'@faapi/faapi': minor
'@faapi/agent': minor
---

任务子系统新增执行上下文携带管道（carry）与 taskCtx.agent 静默组装通道：

- `enqueue` / `enqueueGroup` / `enqueueChain` 新增 `opts.carry` 选项——声明执行上下文快照（身份/标记等纯数据，enqueue 时刻校验可结构化克隆、显式抛错），随任务 envelope 持久化（驱动载荷包装形态，pgboss/bullmq 同步支持，旧格式任务向后兼容），执行端还原到 `taskCtx.carry`。**身份在 enqueue 处声明一次**（如 `carry: { currentUserId: ctx.currentUserId }`），任务端零声明——Sidekiq Current / Temporal headers 同款的上下文传播模式
- 任务内续投（`taskCtx.tasks.enqueue*`）自动继承当前 carry（显式传 carry 整体覆盖）；`tasks.resume` 激活重投继承挂起前 carry；cron 触发归一空对象；隔离路径 carry 随 run 消息快照下发（纯数据天然跨线程）
- 进程内任务的 `taskCtx.agent` 惰性通道（7.1）：首次访问经 agentHandle 工厂以 `{ ...taskCtx.carry }` 为执行 ctx 构造并缓存复用——与 HTTP 请求链的 `agent` 参数注入同一份 baseDeps，任务链 agent 获取与请求链对称（`taskCtx.agent` vs `agent` 参数）、零组装代码；类型由 `@faapi/agent` 的 declare module 声明合并增强为 `AgentHandle | undefined`（未安装该包时类型与运行时一致）。隔离任务无此通道（显式 undefined，能力边界——工厂为宿主闭包不可跨线程）

细则见 `packages/faapi/src/tasks/taskTypes.md`（carry 与 agent 通道章节）。
