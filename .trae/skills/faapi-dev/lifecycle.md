# 场景:生命周期钩子

## 何时加载

用户要配置 `lifecycle` 生命周期钩子（onBoot / onReady / onClose / onError）。

## 配置方式

```ts
export default {
  lifecycle: {
    async onBoot({ rootDir, routes, registries }) {
      // server.listen 之前调用（启动校验钩子）
      // 适合:环境变量校验、下游依赖可达性检查、DB 迁移等"失败即不该暴露端口"的逻辑
      if (!process.env.DB_HOST) {
        throw new Error('DB_HOST is required'); // 抛错 → listen() reject，端口不暴露
      }
    },
    async onReady({ rootDir, routes, server, registries }) {
      // server 启动后调用
      // 初始化数据库连接、Redis 等
      console.log(`Server ready with ${routes.length} routes`);
      // DB-driven skill 经 app 实例注册表灌入(与 app 生命周期绑定):
      // registries.skill.hydrate(skills)
    },
    async onClose({ rootDir, server }) {
      // 优雅关闭时调用(SIGTERM/SIGINT,默认注册;drain 在途请求后执行)
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
| `onBoot` | `server.listen` 之前 | 启动校验（环境变量、下游依赖）、DB 迁移——失败即不该暴露端口的逻辑 |
| `onReady` | server.listen 后 | 初始化资源（DB 连接、缓存预热） |
| `onClose` | SIGTERM/SIGINT 时 | 优雅关闭（断开连接、释放资源）。信号默认注册：收到信号 → drain 在途请求 → 执行 onClose → 退出 |
| `onError` | 错误响应已发出后 | 副作用（日志上报、告警、链路追踪） |

**onBoot 与 onReady 的时序差异**：onBoot 在 `app.listen()` 内、`server.listen` 调用**之前**执行（此时 server 已创建但未监听，`server.listening === false`；路由/tool/agent 清单已水合、插件已加载）。onBoot 抛错 → `listen()` 以原始错误 reject，端口不暴露。onReady 在 listen 回调内执行，失败时端口已开，存在"接受连接但不服务"的窗口——**启动校验放 onBoot，资源初始化放 onReady**。

## LifecycleContext

```ts
interface LifecycleContext {
  rootDir: string;
  routes: RouteManifest;
  server: Server;
  registries: AppRegistries; // app 级注册表(tool/agent/skill/agentHandle)
}
```

## 在钩子中 import 项目模块

`onBoot` / `onReady` / `onClose` 中调用项目模块(校验环境变量、初始化数据库、预热缓存),直接静态 `import` 即可,dev/prod 行为一致:

```ts
// faapi.config.ts
import { initDb } from './src/lib/db';

export default {
  lifecycle: {
    async onBoot() {
      // 启动校验(失败即不暴露端口)
      if (!process.env.DB_HOST) throw new Error('DB_HOST is required');
    },
    async onReady() {
      await initDb();
    },
  },
} satisfies FaapiConfig;
```

不要在 config 顶层执行有副作用的代码(如 `initDb()`):启动校验放 `onBoot`,资源初始化放 `onReady`。
