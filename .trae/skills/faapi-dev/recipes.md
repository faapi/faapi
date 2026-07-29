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

## 响应压缩

faapi 不内置响应压缩中间件——动态 API 的响应多为小 JSON，压缩收益有限且增加 CPU 开销。生产环境**推荐在反向代理（nginx/Caddy）层处理压缩**，faapi 仅返回未压缩响应。

如需在应用层压缩（如自托管无反向代理场景），用 `node:zlib` 自行实现中间件：

```ts
// middlewares/compression.ts
import type { FaapiMiddleware } from '@faapi/faapi';
import { gzip, deflate } from 'node:zlib';
import { promisify } from 'node:util';

const gzipAsync = promisify(gzip);
const deflateAsync = promisify(deflate);

export function compression(): FaapiMiddleware {
  return async (ctx, next) => {
    // next() 返回内层 Response（faapi 洋葱模型，中间件可替换内层响应）
    const response = await next();

    // 已压缩 / 非 2xx / 无 body → 透传
    if (response.headers.get('content-encoding')) return response;
    if (response.status < 200 || response.status >= 300) return response;

    const acceptEncoding = ctx.headers.get('accept-encoding') ?? '';
    if (!acceptEncoding.includes('gzip') && !acceptEncoding.includes('deflate')) {
      return response;
    }

    const body = await response.text();
    if (!body) return response;

    try {
      let buf: Buffer;
      let encoding: string;
      if (acceptEncoding.includes('gzip')) {
        buf = await gzipAsync(Buffer.from(body));
        encoding = 'gzip';
      } else {
        buf = await deflateAsync(Buffer.from(body));
        encoding = 'deflate';
      }
      const headers = new Headers(response.headers);
      headers.set('Content-Encoding', encoding);
      headers.set('Content-Length', String(buf.byteLength));
      return new Response(buf, { status: response.status, headers });
    } catch {
      return response; // 压缩失败透传原响应
    }
  };
}

// faapi.config.ts
export default {
  middlewares: [compression()],
} satisfies FaapiConfig;
```

> **注意**：中间件在 `await next()` 之后返回新 Response 会替换内层响应。流式响应（SSE）的 handler 返回后由框架自动 close writer，压缩中间件拿到的是已 finalize 的 Response；WebSocket 事件回调阶段不走洋葱中间件，无需特殊处理。
