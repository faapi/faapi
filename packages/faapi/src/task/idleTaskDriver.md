# idleTaskDriver

一句话概括：无任务清单时的队列占位驱动——startWorker/stop 空操作，enqueue 显式报错引导配置驱动。

## 为什么需要

任务驱动（pg-boss/bullmq）需要外部存储依赖，而 `createTaskQueue` 必须持有一个 TaskDriver 实例才能创建。零任务项目不应被迫安装驱动子包——注册表为空时 `createAppBase` 用本占位驱动创建队列，保持零依赖起步；同时占位驱动不提供任何存储语义，避免"看似有队列实则无驱动"的静默降级。

## 使用场景

- `createAppBase` 水合任务清单为空时（`taskMetas.length === 0`）

## 行为约定

- `enqueue` → 抛错：提示新注册的任务需要配置 `config.task.driver`（覆盖 dev `reloadTasks` 后新增任务的场景——驱动在 app 创建时定死，不做运行时切换，需重启生效）
- `startWorker` / `stop` / `stopWorkers` → 空操作（无任务无消费，stop 即返回）

## 相关模块

- `src/task/driverTypes.ts` — TaskDriver 接口
- `src/task/loadTaskDriver.ts` — 有任务清单时的驱动解析（与本模块互补）
- `src/cli/createAppCore.ts` — 调用方
