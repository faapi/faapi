# taskTypes

一句话概括：任务子系统的全部类型定义（任务元信息、扫描清单、运行时元数据、任务记录、客户端与队列接口、配置节），供各模块与公开导出共用。

## 为什么需要

scanTasks（构建期）、taskRegistry（运行时）、taskQueue（执行）、taskClient（触发入口）分处不同层，类型必须单一来源，避免各层重复声明导致字段漂移。

## 使用场景

- 业务方 `import type { FaapiTaskMeta, TaskClient, TaskContext, TaskJob } from '@faapi/faapi'`
- 框架内部 scanTasks → generateTaskArtifacts → taskRegistry → taskQueue 传递

## 相关模块

- 被本目录所有模块与 `src/config/configTypes.ts`（TaskConfig）、`src/injection/registries.ts`（TaskRegistry）引用
