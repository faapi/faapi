# @faapi/task-bullmq

faapi 任务子系统的 **BullMQ 驱动**（Redis 持久化队列）。

基于 Redis 的任务队列——任务不丢（持久化）、多实例天然防重跑（worker 领取制）、支持延迟任务与指数退避重试。适合已有 Redis 基础设施或需要高吞吐的项目。

## 安装

```bash
pnpm add @faapi/task-bullmq bullmq ioredis
```

> bullmq 6 起 `ioredis` 由内置依赖移至 peer dependency——需业务方显式安装（bullmq 5 时代无需）。
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
| `enqueue(name, payload, { retries, delayMs, dedupId })` | `queue.add(name, payload, { attempts: retries + 1, backoff: exponential 500ms, delay, removeOnComplete, removeOnFail, jobId })`。终态任务默认 7 天后移除（`removeOnComplete`/`removeOnFail` 可覆盖，`false` 恢复永不清理）——BullMQ 默认永久保留终态任务，Redis 无界增长且 dedupId 去重在存活期内一直生效 |
| `startWorker(name, { concurrency, process })` | `new Worker(name, handler, { connection, concurrency, prefix })`；attempt 取 `job.attemptsStarted`（跨实例/重启准确） |
| `stop(timeoutMs)` | workers.close() + queues.close()（race 超时），超时 abort 在跑任务的 signal |
| `stopWorkers()` | 仅关 Worker（dev 热替换重注册用），Queue 连接保持 |
| `groups`（任务组记账，语义见主包 taskGroups.md） | 两组 Redis key：`<prefix>:group:<id>`（组行 hash）+ `<prefix>:group-members:<id>`（成员行 hash，jobId→状态幂等守卫），常驻不自动清理；经 `defineCommand`/`runCommand`（BullMQ 类型化 Lua 扩展口，专用连接复用连接池不加新连接）原子计账。成员组标识以载荷包装随 data 存储（`{ __faapiGroup, __faapiPayload }`，交付/查询还原）；`cancelRemaining` 仅对 waiting/delayed 成员 `job.remove()`，移除成功才落定 |
| 失败重试 | BullMQ 侧执行（attempts = retries + 1，指数退避 500ms 起） |

注意：BullMQ 不提供执行中任务的取消信号，但 `stop` 超时路径会 abort `taskCtx.signal`（任务监听 signal 可尽快退出）。

## License

MIT
