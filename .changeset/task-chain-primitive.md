---
'@faapi/faapi': minor
---

新增链式任务原语 `TaskClient.enqueueChain(name, payload, { chainKey })`——按链键键控单飞（同键活跃任务存在则不投返回现状），dedupId 框架托管（终态后可重投），任务执行路径（taskCtx.tasks）调用自动排除自身 job。收编"长时任务分段推进、段尾自续投下一段"场景的活跃查证 / 排除自身 / 幂等键管理三件编排样板，与任务组原语正交（组是并行扇出 + fan-in，链是串行单飞 + 自续投）。chainKey 经载荷包装随任务持久化（TaskJob.chainKey 可查），活跃查证走 TaskDriver.list 通道（未实现显式抛错）。
