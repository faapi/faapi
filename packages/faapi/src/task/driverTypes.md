# driverTypes

一句话概括：任务队列驱动抽象——语义层（校验/模块加载/记录）与存储调度层（入队/消费/重试/停机）的边界接口。

## 为什么需要

第一版 taskQueue 把内存存储和调度语义耦合在一个实现里，无法接入 pg-boss / BullMQ。抽出 TaskDriver 后：换驱动 = 换存储，业务方仍用文件约定任务 + `tasks.enqueue`，重启丢任务/多实例防重跑由外部驱动天然解决。

## 使用场景

- 业务方 `config.task.driver: 'pgboss' | 'bullmq'`（子包提供）或传入自定义 TaskDriver 实例
- 子包 `@faapi/task-pgboss` / `@faapi/task-bullmq` 实现此接口
- 主包内置 memoryDriver 为默认实现

## 约定

- 重试策略在**入队时**由语义层传 `retries`（从任务 meta 取），驱动负责执行（memory：指数退避；pg-boss：retryLimit/retryBackoff；bullmq：attempts/backoff）
- `process` 抛错 = 本次执行失败，驱动决定是否重试；语义层在每次 process 调用中更新任务记录（attempt/done/failed）
- `stop(timeoutMs)` 停消费等 in-flight；`stopWorkers()` 仅停消费不断连接（dev 热替换重注册用，可选实现）

## 相关模块

- `src/task/memoryDriver.ts` — 默认实现
- `src/task/loadTaskDriver.ts` — 按 config.task.driver 动态加载子包驱动
- `src/task/taskQueue.ts` — 语义层消费方
