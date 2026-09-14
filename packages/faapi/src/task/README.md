# task — 队列式异步任务子系统

一句话概括：基于外部队列驱动的异步任务能力——handler/生命周期/cron 把耗时工作投递到队列，由驱动 worker 按 task 元信息（并发数、重试）消费执行。

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
  // timeoutMs: 10 * 60_000, // 执行超时（最小 60s）：超时真终止（隔离线程执行，两段式取消）
  // graceMs: 15_000,        // 取消宽限期（默认 5s）：abort 信号后等待自行退出的时长
  // cron: '0 3 * * *',  // 定时入队（croner 表达式），到点自动 enqueue 空 payload
} satisfies FaapiTaskMeta;
export function run(payload: Payload, taskCtx: TaskContext) {
  return { sent: true };
}

// 2. 配置驱动（有任务清单时必填）：faapi.config.ts
export default {
  task: {
    driver: 'pgboss',                              // 或 'bullmq'
    pgboss: { connectionString: 'postgres://localhost:5432/app' },
  },
} satisfies FaapiConfig;

// 3. handler 里入队（tasks 参数注入）；dedupId 幂等键（可选）——同键保留期内不重复入队
export function POST(body: { email: string; orderId: string }, tasks: TaskClient) {
  return tasks.enqueue('send-email', { to: body.email, template: 'welcome' }, {
    dedupId: `order-confirm:${body.orderId}`, // 防重复投递（驱动实现见 driverTypes.md）
  });
}

// 4. 管理：查询持久化队列 / 取消 / 重试（能力随驱动，见 driverTypes.md）
const queued = await tasks.listQueued('send-email'); // 队列侧任务（含其他实例/历史）
await tasks.cancel('send-email', queued[0].id);      // 取消等待/延迟中的任务
await tasks.retry('send-email', failed.id);          // 重试失败/取消的任务

// 5. 中间件 / 编程式：ctx.tasks（同 TaskClient）、app.tasks、lifecycle 钩子的 { tasks }

// 6. 任务内访问 app 注册表（只读视图）：组装/调用 agent 不再依赖 getApp()——
//    进程内任务拿活引用，隔离任务（timeoutMs）拿派发时刻的纯数据快照（worker 内重建）
export async function run(payload: Payload, taskCtx: TaskContext) {
  const agent = taskCtx.registries.agent.getAgent('log-analyzer');
  if (!agent) throw new Error('agent "log-analyzer" not registered');
  return { analyzed: true };
}
```

## 模块组成

| 模块 | 职责 |
|------|------|
| `taskTypes.ts` | 子系统全部类型（meta / manifest / metadata / job / client / queue / config） |
| `scanTasks.ts` | CLI 扫描 `src/tasks/**/task.ts`（零 import，正则提取 meta），产出 TaskManifest[] |
| `taskRegistry.ts` | app 级 TaskRegistry（hydrate/get/list/clear，方案 A 实例化） |
| `taskQueue.ts` | 队列语义层：payload zod 校验 + worker 执行包装（模块加载/run/记录）+ 生命周期编排 |
| `driverTypes.ts` | `TaskDriver` 驱动抽象（存储/消费/重试/停机的边界接口） |
| `loadTaskDriver.ts` | 按 `config.task.driver` 动态加载子包驱动 / 透传自定义实例，缺失显式抛错 |
| `idleTaskDriver.ts` | 空闲占位驱动（无任务清单时使用，enqueue 显式报错引导配置驱动） |
| `taskWorker.ts` | 隔离执行器：`timeoutMs` 任务在独立线程执行，超时两段式取消（真终止） |
| `cronScheduler.ts` | cron 表达式到点自动入队（croner） |
| `../cli/generateTaskArtifacts.ts` | 生成 `faapi-tasks.js` 清单 + 各任务的 `zod.js`（Payload schema） |

## 设计决策

- **超时取消必须真终止（worker 隔离执行）**：Node 主线程无法强杀协程——进程内"不再等待"式的超时是假取消（控制侧记失败、重试已投递，旧协程仍在跑）。因此任务声明 `task.timeoutMs` 后走 `taskWorker.ts` 隔离线程执行，超时两段式取消：先 abort 信号给任务优雅退出（宽限 5s），未退出 `terminate()` 硬杀——判定超时即执行真正终止。取消与失败分流：被框架终止的任务记 `cancelled`（`TaskCancelledError` / job.signal 已 abort），run 自身出错记 `failed`。代价：隔离任务有 worker 冷启动开销、模块级状态每次执行独立、`taskCtx.config` 为可克隆纯数据快照（详见 taskWorker.md）。停机超时由驱动 abort 在跑任务的 signal（pgboss/bullmq 已接线），进程退出兜底终止。
- **任务侧注册表访问走只读视图（而非 getApp()）**：注册表是 app 实例级（方案 A），而 `getApp()` 在隔离 worker 线程内不可用（globalThis 独立）、全局访问器读的是 app 启动从不水合的默认实例——任务侧曾没有任何注册表访问路径。现两条执行路径都注入 `taskCtx.registries`（只读视图，不含 hydrate/clear 写接口）：进程内传活引用；隔离路径注册表对象含函数闭包不可跨线程，由语义层生成纯数据快照（agents 含 filePath/hasRun 完整元数据 + tools + skills）postMessage 传入、worker 内重建视图。**快照语义**：视图反映派发时刻的注册表，执行中途 reload/DB skill 变更不影响当次执行（与 worker 模块图独立的既有语义一致）。
- **驱动必填（memory 内置驱动已移除）**：队列语义（存储/消费/重试/停机）抽象为 `TaskDriver` 接口（driverTypes.md），由独立子包提供实现——`@faapi/task-pgboss`（Postgres）、`@faapi/task-bullmq`（Redis），主包零依赖、按 `config.task.driver` 动态加载（loadTaskDriver.ts），未安装/未配置显式报错不静默降级。**存在任务清单时必须显式配置 driver**，否则 `createAppBase` 启动报错；无任务清单的项目不加载驱动（零任务项目无需安装驱动子包，`createAppBase` 用空闲占位驱动 idleTaskDriver）。进程内重启丢任务/多实例不防重跑的问题由持久化驱动天然解决——框架不再提供"可丢任务"的默认实现。
- **统一产物驱动**：dev/prod 产物集一致（`faapi-tasks.js` + `tasks/**/zod.js` + `tasks/**/task.js`），`createAppBase` 无 `if (isDev)` 分支。dev 与 handler 不同，任务文件启动时全量编译（任务数量小，且 worker 运行时 import 失败无法像 HTTP 请求那样反馈给调用方）。
- **任务与定时一条线**：cron 只是"自动投递者"，到点调 `enqueue`，复用同一队列与执行模型，不做第二套执行器。
- **触发入口三合一**：`tasks` 参数注入 / `ctx.tasks` / `app.tasks` 与 lifecycle `{ tasks }` 全部指向同一 app 实例的 TaskClient；不做外部 HTTP 触发端点。
- **payload 校验复用 zod 代码生成链路**：`run` 首参类型（如 `Payload` interface）走 AST → zod 代码生成，入队时 safeParse，不合法抛 `ValidationError`（422）。无 Payload 类型声明则跳过校验（与 tool 行为对齐）。
- **不实现 handler 返回值隐式投递**：混淆统一响应包装语义。
- **失败钩子**：`config.task.onFailed` 在每次任务执行失败/取消后触发（含将重试的失败，`info.willRetry` / `info.cancelled` 区分），用于告警/死信上报等副作用；自身抛错被忽略。
- **管理端点不内置（业务方自建）**：管理 API（`listQueued`/`cancel`/`retry`）必须受鉴权保护，框架内置路由默认无鉴权是安全陷阱。业务方在受保护目录写 handler 即可暴露（见下方示例）——这符合"路由文件约定 + 注入即用"的框架范式。

### 管理端点示例（放在鉴权中间件保护的目录）

```ts
// src/api/admin/tasks/handler.ts —— api/admin/ 下挂全局鉴权中间件（见 AGENTS.md 5.4）
import type { TaskClient } from '@faapi/faapi';

export function GET(query: { name?: string }, tasks: TaskClient) {
  return tasks.listQueued(query.name);
}

export function DELETE(params: { id: string }, tasks: TaskClient) {
  return tasks.cancel('send-email', params.id);
}
```

## 相关模块

- `src/injection/registries.ts` — AppRegistries 增加 `task`（TaskRegistry）与 `taskHandle`（TaskClient 工厂）
- `src/injection/resolveInjection.ts` / `injectParams.ts` — `tasks` 内置注入参数
- `src/cli/createAppCore.ts` — `loadAndHydrateTasks`、驱动加载与队列启动/停机接线、`FAAPI_CONFIG_KEYS` 加 `task`
- `src/cli/devCommand.ts` / `buildCommand.ts` / `watcher.ts` / `createDevApp.ts` — 产物生成与 `reloadTasks` 热替换
- `src/config/configTypes.ts` — `TaskConfig`
- `src/validator/` — `ValidationError`（payload 校验失败）
