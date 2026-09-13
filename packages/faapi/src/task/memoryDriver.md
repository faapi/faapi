# memoryDriver

一句话概括：TaskDriver 的默认实现——进程内数组存储 + worker 循环，零依赖，行为与第一版内存队列完全一致。

## 为什么需要

第一版 taskQueue 的存储调度逻辑原样下沉为独立驱动，作为无外部依赖时的默认行为；同时作为外部驱动（pg-boss/bullmq）的行为参照实现。

## 使用场景

- `config.task.driver` 未设置 / `'memory'`（默认）
- 单实例部署、任务可丢（重启丢任务，见 fallback.md）

## 行为约定

- 见 driverTypes.md 的驱动约定；本实现特有：
  - 指数退避重试：`min(500ms * 2^(attempt-1), 30s)`
  - `stop` 超时后对在跑任务 abort（run 的 `taskCtx.signal` 触发）
  - `stopWorkers` 仅清空 worker 注册（dev reloadTasks 后由语义层重新注册）

## 相关模块

- `src/task/driverTypes.ts` — 接口定义
- `src/task/taskQueue.ts` — 语义层
