# @faapi/task-pgboss

faapi 任务子系统的 **pg-boss 驱动**（PostgreSQL 持久化队列）。

基于 PostgreSQL 的任务队列——任务不丢（持久化）、多实例天然防重跑（worker 领取制）、cron 重复投递由 pg-boss 消费语义兜底。复用业务方已有的 Postgres，不引入 Redis。

## 安装

```bash
pnpm add @faapi/task-pgboss pgboss
```

## 使用

任务定义不变（主包文件约定 `src/tasks/<name>/task.ts`），只切驱动：

```ts
// faapi.config.ts
import type { FaapiConfig } from '@faapi/faapi';

export default {
  task: {
    driver: 'pgboss',
    pgboss: { connectionString: 'postgres://localhost:5432/app' }, // 透传给 new PgBoss(...)
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

| faapi 驱动接口 | pg-boss |
| --- | --- |
| `enqueue(name, payload, { retries, delayMs })` | `boss.send(name, payload, { retryLimit, retryDelay: 1, retryBackoff: true, startAfter })` |
| `startWorker(name, { concurrency, process })` | `boss.work(name, { batchSize: concurrency }, handler)` |
| `stop(timeoutMs)` | 停 work + `boss.stop({ close: true, timeout })` |
| `stopWorkers()` | `offWork()`（不断开连接，dev 热替换重注册用） |
| 失败重试 | pg-boss 侧执行（retryLimit + retryBackoff 指数退避） |

注意：pg-boss 不提供执行中任务的取消信号——`run` 的 `taskCtx.signal` 永不 abort，长任务请自行做超时控制。

## License

MIT
