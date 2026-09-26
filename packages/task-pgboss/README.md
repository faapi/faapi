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
| `enqueue(name, payload, { retries, delayMs, dedupId, timeoutMs, graceMs })` | 幂等 `createQueue(name)`（每任务名每进程一次，缓存短路）→ `boss.send(name, payload, { retryLimit, retryDelay: 1, retryBackoff: true, expireInSeconds, startAfter, id })`。`expireInSeconds` = `timeoutMs + graceMs + 60s` 缓冲（未声明 `timeoutMs` 的任务用 `defaultExpireSeconds` 兜底，默认 24h − 1s；pg-boss 10 断言 expire 严格小于 24h，上界排他）——pg-boss 以 expire_in 硬限执行，不映射会让 DDL 默认 15 分钟强杀仍在运行的长任务并重试 |
| `startWorker(name, { concurrency, process })` | 幂等 `createQueue(name)` → `boss.work(name, { batchSize: concurrency }, handler)`。批内任务并发执行、逐任务 `complete`/`fail` 结算——单个任务失败只消耗自己的重试额度，不毒化同批 |
| `stop(timeoutMs)` | `offWork`（与 deadline 竞速，卡死任务不悬挂停机）+ `boss.stop({ close: true, graceful: true, timeout })`（timeout 单位毫秒）；deadline 到点 abort 在跑任务的 signal |
| `stopWorkers()` | `offWork()`（不断开连接，dev 热替换重注册用） |
| 失败重试 | pg-boss 侧执行（retryLimit + retryBackoff 指数退避） |

注意：pg-boss v10 不再隐式建队列（`send()` 对未创建队列静默返回 null）——驱动在投递/注册 worker 前自动幂等建队列，业务方无需预建。pg-boss 自身不提供执行中任务的取消信号，但 `stop` 超时路径会 abort `taskCtx.signal`（任务监听 signal 可尽快退出；仍不退出的由 expire_in 兜底结算）。

## License

MIT
