# task — 队列式异步任务子系统

一句话概括：基于进程内内存队列的异步任务能力——handler/生命周期/cron 把耗时工作投递到队列，由后台 worker 按 task 元信息（并发数、重试）消费执行。

## 为什么需要

框架此前没有任何定时/异步任务能力，业务方只能自己在 `lifecycle.onReady` 里裸写 `setInterval` 并在 `onClose` 手动清理，无重试、无并发控制、无 payload 校验。本子系统把"投递 → 队列 → worker 执行 → 重试/失败记录 → 优雅停机"整条链路产品化，并复用框架既有范式（文件约定、产物清单、app 级 registry、统一产物驱动）。

## 使用场景

```ts
// 1. 任务定义（文件约定）：src/tasks/<name>/task.ts
export interface Payload {
  to: string;
  template: string;
}
export const task = {
  concurrency: 2,   // 并发数，默认 1
  retries: 3,       // 失败重试次数，默认 0
  // cron: '0 3 * * *',  // 定时入队（croner 表达式），到点自动 enqueue 空 payload
} satisfies FaapiTaskMeta;
export function run(payload: Payload, taskCtx: TaskContext) {
  return { sent: true };
}

// 2. handler 里入队（tasks 参数注入）
export function POST(body: { email: string }, tasks: TaskClient) {
  return tasks.enqueue('send-email', { to: body.email, template: 'welcome' });
}

// 3. 中间件 / 编程式：ctx.tasks（同 TaskClient）、app.tasks、lifecycle 钩子的 { tasks }
```

## 模块组成

| 模块 | 职责 |
|------|------|
| `taskTypes.ts` | 子系统全部类型（meta / manifest / metadata / job / client / queue / config） |
| `scanTasks.ts` | CLI 扫描 `src/tasks/**/task.ts`（零 import，正则提取 meta），产出 TaskManifest[] |
| `taskRegistry.ts` | app 级 TaskRegistry（hydrate/get/list/clear，方案 A 实例化） |
| `taskQueue.ts` | 队列语义层：payload zod 校验 + worker 执行包装（模块加载/run/记录）+ 生命周期编排 |
| `driverTypes.ts` | `TaskDriver` 驱动抽象（存储/消费/重试/停机的边界接口） |
| `memoryDriver.ts` | 默认内存驱动（TaskDriver 实现，零依赖） |
| `loadTaskDriver.ts` | 按 `config.task.driver` 解析驱动（memory / 动态加载子包 / 自定义实例） |
| `cronScheduler.ts` | cron 表达式到点自动入队（croner） |
| `../cli/generateTaskArtifacts.ts` | 生成 `faapi-tasks.js` 清单 + 各任务的 `zod.js`（Payload schema） |

## 设计决策

- **驱动抽象（memory 默认，外部持久化队列可选）**：队列语义（存储/消费/重试/停机）抽象为 `TaskDriver` 接口（driverTypes.md）。内置 memoryDriver（进程内，零依赖）；持久化驱动由独立子包提供——`@faapi/task-pgboss`（Postgres）、`@faapi/task-bullmq`（Redis），主包零依赖、按 `config.task.driver` 动态加载（loadTaskDriver.ts），未安装显式报错不静默回退。memory 驱动下重启丢任务、多实例不防重跑（见 fallback.md）；外部驱动由队列系统天然解决。
- **统一产物驱动**：dev/prod 产物集一致（`faapi-tasks.js` + `tasks/**/zod.js` + `tasks/**/task.js`），`createAppBase` 无 `if (isDev)` 分支。dev 与 handler 不同，任务文件启动时全量编译（任务数量小，且 worker 运行时 import 失败无法像 HTTP 请求那样反馈给调用方）。
- **任务与定时一条线**：cron 只是"自动投递者"，到点调 `enqueue`，复用同一队列与执行模型，不做第二套执行器。
- **触发入口三合一**：`tasks` 参数注入 / `ctx.tasks` / `app.tasks` 与 lifecycle `{ tasks }` 全部指向同一 app 实例的 TaskClient；不做外部 HTTP 触发端点。
- **payload 校验复用 zod 代码生成链路**：`run` 首参类型（如 `Payload` interface）走 AST → zod 代码生成，入队时 safeParse，不合法抛 `ValidationError`（422）。无 Payload 类型声明则跳过校验（与 tool 行为对齐）。
- **不实现 handler 返回值隐式投递**：混淆统一响应包装语义。

## 相关模块

- `src/injection/registries.ts` — AppRegistries 增加 `task`（TaskRegistry）与 `taskHandle`（TaskClient 工厂）
- `src/injection/resolveInjection.ts` / `injectParams.ts` — `tasks` 内置注入参数
- `src/cli/createAppCore.ts` — `loadAndHydrateTasks`、队列启动/停机接线、`FAAPI_CONFIG_KEYS` 加 `task`
- `src/cli/devCommand.ts` / `buildCommand.ts` / `watcher.ts` / `createDevApp.ts` — 产物生成与 `reloadTasks` 热替换
- `src/config/configTypes.ts` — `TaskConfig`
- `src/validator/` — `ValidationError`（payload 校验失败）
