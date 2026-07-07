# 场景:业务方自行实现功能

以下功能 faapi **不内置**——它们要么在框架层面实现"看上去有但不实用"（handler 已跑完才生效），要么与框架设计自相矛盾。这里提供中间件示例，业务方按需在 `middlewares` 中自行注册。

## ETag 协商缓存

faapi 提供 `ctx.setETag(value)` 方法设置 ETag 响应头，但**不自动做 304 协商缓存**——业务方根据自身数据特征在 handler 中自行判断。

```ts
// api/items/[id]/handler.ts
export async function GET(ctx) {
  // 1. 轻量检查：只查版本号，不查完整数据
  const version = await getItemVersion(ctx.params.id);
  ctx.setETag(`"${version}"`);

  // 2. 版本匹配 → 304，不跑重量查询
  const ifNoneMatch = ctx.headers.get('if-none-match');
  if (ifNoneMatch && ifNoneMatch.includes(version)) {
    return new Response(null, { status: 304 });
  }

  // 3. 版本不匹配 → 执行完整查询，返回 200 + ETag
  const item = await getItemById(ctx.params.id);
  return item;
}
```

> **为什么不自动做 304？** 框架在 handler 执行前不知道内容是否变化——必须 handler 自己告知（如上面先查 version）。框架级自动 ETag（读 body 算 hash）在动态 API 场景下 handler 已经全跑完了，304 只省带宽不省计算，收益有限。

## 限流

生产环境推荐用 Redis 存储，兼容 cluster 多进程：

```ts
// middlewares/rateLimit.ts
import type { FaapiMiddleware } from '@faapi/faapi';
import { Redis } from 'ioredis';

const redis = new Redis(process.env.REDIS_URL!);

export function rateLimit(opts: { max?: number; windowMs?: number } = {}): FaapiMiddleware {
  const { max = 60, windowMs = 60_000 } = opts;

  return async (ctx, next) => {
    const key = `ratelimit:${ctx.ip}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.pexpire(key, windowMs);

    if (count > max) {
      return new Response(JSON.stringify({ error: 'Too many requests' }), { status: 429 });
    }
    return await next();
  };
}

// faapi.config.ts
export default {
  middlewares: [rateLimit({ max: 100, windowMs: 60_000 })],
} satisfies FaapiConfig;
```

## 请求超时

```ts
// middlewares/timeout.ts
import type { FaapiMiddleware } from '@faapi/faapi';

export function timeout(ms: number = 30_000): FaapiMiddleware {
  return async (_ctx, next) => {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Request timeout')), ms);
    });
    try {
      return await Promise.race([next(), timeout]);
    } finally {
      clearTimeout(timer!);
    }
  };
}

// faapi.config.ts
export default {
  middlewares: [timeout(30_000)],
} satisfies FaapiConfig;
```

## 集群模式

```ts
// cluster.ts — 独立入口脚本，用 node cluster.ts 启动
import cluster from 'node:cluster';
import { cpus } from 'node:os';
import { createApp } from '@faapi/faapi';

if (cluster.isPrimary) {
  const numWorkers = cpus().length;
  console.log(`Primary ${process.pid} forking ${numWorkers} workers`);
  for (let i = 0; i < numWorkers; i++) cluster.fork();
  cluster.on('exit', (worker) => {
    console.log(`Worker ${worker.process.pid} exited, restarting...`);
    cluster.fork();
  });
} else {
  createApp().then((app) => app.listen());
}
```
