# @faapi/task-bullmq

faapi 任务子系统的 **BullMQ 驱动**（Redis 持久化队列）。

基于 Redis 的任务队列——任务不丢（持久化）、多实例天然防重跑（worker 领取制）、支持延迟任务与指数退避重试。适合已有 Redis 基础设施或需要高吞吐的项目。

## 安装

```bash
pnpm add @faapi/task-bullmq bullmq
```

## 使用

任务定义不变（主包文件约定 `src/tasks/<name>/task.ts`），只切驱动：

```ts
// faapi.config.ts
import type { FaapiConfig } from '@faapi/faapi';

export default {
  task: {
    driver: 'bullmq',
    bullmq: { connection: { host: '127.0.0.1', port: 6379 } },
    // 可选：同 Redis 下多应用隔离
    // bullmq: { connection: {...}, prefix: 'myapp' },
  },
} satisfies FaapiConfig;
```

```ts
// handler 里用法完全不变
export function POST(body, tasks) {
  return tasks.enqueue('send-email', { to: body.email });
}
```

## 语义映射

| faapi 驱动接口 | BullMQ |
| --- | --- |
| `enqueue(name, payload, { retries, delayMs })` | `queue.add(name, payload, { attempts: retries + 1, backoff: exponential 500ms, delay })` |
| `startWorker(name, { concurrency, process })` | `new Worker(name, handler, { connection, concurrency, prefix })` |
| `stop(timeoutMs)` | workers.close() + queues.close()（race 超时） |
| `stopWorkers()` | 仅关 Worker（dev 热替换重注册用），Queue 连接保持 |
| 失败重试 | BullMQ 侧执行（attempts = retries + 1，指数退避 500ms 起） |

注意：BullMQ 不提供执行中任务的取消信号——`run` 的 `taskCtx.signal` 永不 abort，长任务请自行做超时控制。

## License

MIT
