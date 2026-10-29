---
'@faapi/faapi': minor
'@faapi/task-pgboss': minor
'@faapi/task-bullmq': minor
---

任务系统批量投递收敛为两形态统一体系：**串行有序**与**并行无序**，共用驱动侧记账（成员行守卫 / unsettle 逆向 / fan-in 回调）、全量 payload 校验前置、同 id 幂等重投自愈与 `TaskGroupSummary` 回调契约。

**新增 `tasks.enqueueSequence(name, payloads, opts)`——串行有序批量**：

- 一次登记 N 条已知 payload，前一条到达终态（含重试耗尽）才激活下一条，业务零 `remaining` 计数、零自续投样板
- payloads 全量校验后随序列行持久化（激活发生在任意实例/重启之后），`carry` 随序列声明逐条注入；`delayMs` 仅作用于首条
- 激活在落定接线内发生：驱动 settle 记账同事务推进激活指针（`GREATEST(next_index, member_index+1)`）返回下一条 payload，成员 dedupId 按 index 幂等兜底重复激活/多实例竞态
- fail-fast 失败终止：不再激活后续条目，未激活成员经 `settleRemaining` 按计数差值补记 `cancelled` 后回调照常触发；run-to-completion（缺省）失败跳过继续
- 同 sequenceId 重投自愈激活两步崩溃窗口（入队 `payloads[nextIndex]`，dedupId 幂等）
- 快照 `getGroup(sequenceId)` 含 `execution: 'serial'` 与 `nextIndex`；未激活成员不在队列中

**新增 `tasks.enqueueBatch(name, payloads, opts)`——并行无序批量**（原 `enqueueGroup` 语义承接）：全部成员立即入队并行执行，成员 dedupId 自动派生 `faapi-group:<batchId>:<index>`，fail-fast 经 `cancelRemaining` 取消队列中未落定成员。

**移除 `tasks.enqueueGroup` / `tasks.enqueueChain`**：`enqueueGroup` 由 `enqueueBatch` 承接（`groupId` 参数更名 `batchId`，dedupId 形状与存储键名不变）；`enqueueChain`（键控单飞自续投链）由 `enqueueSequence` 承接——`TaskJob.chainKey` 与载荷 `__faapiChain` 载体随之移除。

**驱动接口扩展**（两官方驱动同步实现，自定义驱动需更新）：`TaskDriverGroupCreate` 新增 `mode`（'serial' | 'parallel'）/ `payloads`（serial 必填）/ `carry`；`TaskDriverGroupSettleResult` 新增 `next`（serial 落定即激活）；`TaskDriverGroupOps` 新增必填方法 `settleRemaining`（serial fail-fast 补齐）；`TaskDriver.enqueue` opts 新增 `groupIndex`（serial 成员序号，交付/查询还原为 `TaskDriverJob.groupIndex`）。task-pgboss 组表/成员表幂等迁移新列（`ADD COLUMN IF NOT EXISTS`，存量行 DEFAULT 'parallel' 语义兼容）；task-bullmq 组 hash 新增字段、成员值扩展 `p:<index>` 编码（兼容存量 `pending`）、settle/settleRemaining Lua 原子化。
