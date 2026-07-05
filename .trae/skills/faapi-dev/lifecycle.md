# 场景:生命周期钩子

## 何时加载

用户要配置 `lifecycle` 生命周期钩子（onReady / onClose / onError）。

## 配置方式

```ts
export default {
  lifecycle: {
    async onReady({ rootDir, routes, server }) {
      // server 启动后调用
      // 初始化数据库连接、Redis 等
      console.log(`Server ready with ${routes.length} routes`);
    },
    async onClose({ rootDir, server }) {
      // 优雅关闭时调用(SIGTERM/SIGINT)
      // 清理资源
      console.log('Server shutting down');
    },
    onError(error, ctx) {
      // 请求错误已发出后触发(参考 Fastify onError 语义)
      // 用于副作用:日志/告警/链路追踪
      // 不修改已发出的响应;自身抛错被忽略
      console.error(`[onError] ${ctx.method} ${ctx.path}`, error);
    },
  },
} satisfies FaapiConfig;
```

## 钩子说明

| 钩子 | 时机 | 用途 |
|------|------|------|
| `onReady` | server.listen 后 | 初始化资源（DB 连接、缓存预热） |
| `onClose` | SIGTERM/SIGINT 时 | 优雅关闭（断开连接、释放资源） |
| `onError` | 错误响应已发出后 | 副作用（日志上报、告警、链路追踪） |

## LifecycleContext

```ts
interface LifecycleContext {
  rootDir: string;
  routes: RouteManifest;
  server: Server;
}
```
