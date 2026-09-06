# 场景:业务方自行实现功能

以下功能 faapi **不内置**——它们要么在框架层面实现"看上去有但不实用"（handler 已跑完才生效），要么与框架设计自相矛盾。这里提供中间件示例，业务方按需在 `middlewares` 中自行注册。

## ETag 协商缓存（内建 + 手动早退出）

**内建**（v4 起）：`config.etag: true` 即自动为 GET/HEAD 2xx 响应生成弱 ETag 并协商 `If-None-Match`（命中返回 304）:

```ts
// faapi.config.ts
export default {
  etag: true,
} satisfies FaapiConfig;
```

适用场景是省**带宽**。若要省**计算**（版本没变就跳过重量级查询），用 `ctx.setETag` 手动早退出——handler 显式设置的 ETag 优先于内建生成:

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

> **两种策略如何选**：内建 etag 零配置省带宽（handler 总会执行）；手动 `ctx.setETag` 早退出省计算（先查版本号再决定是否跑重量查询）。两者可共存，handler 设置优先。

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

> **前置条件**：`createApp` 是 `createProdApp` 的别名，会检查 `dist/faapi-routes.js` 是否存在。启动前必须先跑 `faapi build` 生成 `dist/` 产物，否则报错 `dist/faapi-routes.js 不存在`。cluster 模式仅适用于 prod，dev 模式用 `faapi dev` 单进程即可。

```ts
// cluster.ts — 独立入口脚本，用 node cluster.ts 启动（需先 faapi build）
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

```bash
faapi build        # 先构建产物
node cluster.ts    # 再启动 cluster
```

## 响应压缩（已内建）

`config.compression: true` 即启用（v4 起内建）：按 `Accept-Encoding` 协商 br > gzip > deflate，SSE/流式响应自动跳过，自动补 `Vary: Accept-Encoding`。`threshold` 选项控制最小压缩字节数（默认 1024，小 payload 压缩反而变大）:

```ts
// faapi.config.ts
export default {
  compression: true,                    // 或 { threshold: 2048 }
} satisfies FaapiConfig;
```

> 生产环境仍可选在反向代理（nginx/Caddy）层压缩——若反代已开启压缩，faapi 侧无需再启用，避免双重压缩。
