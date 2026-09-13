# taskRegistry

一句话概括：app 实例级任务注册表——保存运行时 TaskMetadata（含产物路径与调度 meta），供 taskQueue 执行与 cronScheduler 调度查询。

## 为什么需要

与 tool/agent/skill registry 同构（方案 A 实例化）：任务清单来自编译期产物，reload 时整体替换；每个 app 持有独立实例，多 app 同进程互不串台。

## 使用场景

- `createAppBase` 经 `loadAndHydrateTasks` 水合
- taskQueue 每次派发时按名查任务 meta（concurrency/retries/module 路径）
- cronScheduler 启动/重载时遍历带 `cron` 的任务
- dev `reloadTasks` 重新水合

## 行为约定

- 接口：`hydrate(TaskMetadata[])`（整体替换）/ `get(name)` / `list()` / `clear()`
- 在 `AppRegistries` 中新增 `task: TaskRegistry` 与 `taskHandle`（TaskClient 工厂 store，同 agentHandle 模式）

## 相关模块

- `src/injection/registries.ts` — AppRegistries 定义
- `src/task/taskQueue.ts` / `src/task/cronScheduler.ts` — 消费方
