---
'@faapi/faapi': minor
---

新增任务事件原语：任务执行中经 `taskCtx.emit(data)` 发射过程事件（agent 流式 chunk、阶段标记等），宿主侧 `TaskClient.subscribe(name, handler)` 实时订阅（本进程同步扇出，不回放历史）+ `listEvents(name, { jobId? })` 查询历史（单执行内 seq 升序；`TaskEvent = { task, jobId, attempt, seq, at, data }`）。与 `progress` 的差异：progress 是单值覆盖槽（派发清空），事件是过程历史（seq 跨 attempt 连续、重试不清、attempt 标注）。仅 running 状态生效（终态后忽略）；隔离路径（声明 `timeoutMs`）值经 postMessage 回传宿主——须可结构化克隆（不可克隆按执行错误处理），取消判定后到达不采纳。事件存本进程有界内存（单执行 1000 / 全局 10000 两级上限），生命周期与任务记录绑定，驱动零改动；隔离任务 `taskCtx.tasks.subscribe` 显式拒绝（回调不可跨线程），`listEvents` 经 RPC 白名单可用。agent 事件不设专用管道 API——`agent.stream` chunk 原样 `emit` 即成管道。完整契约见 `packages/faapi/src/task/taskEvents.md`。
