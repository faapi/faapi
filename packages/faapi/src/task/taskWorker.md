# taskWorker

一句话概括：任务隔离执行器——把声明了 `timeoutMs` 的任务放进独立 worker 线程执行，超时两段式取消（先发优雅取消信号、宽限未退出再 `terminate()` 硬杀），保证"判定超时 = 执行真正终止"。

## 为什么需要

Node 主线程无法强杀协程：进程内执行的任务一旦卡住（死循环、上游 hang），框架只能"不再等待"而无法终止它——控制侧记了失败、重试已投递，旧协程仍在后台跑（假取消）。`worker_threads` 的 `terminate()` 是 Node 唯一能硬终止执行的机制，把任务执行放进隔离线程后，超时取消才具备"实际生效"的保证。

## 使用场景

- 任务声明 `task.timeoutMs`（`src/tasks/<name>/task.ts` 的 meta）→ 该任务的每次执行走本执行器（隔离执行）
- 未声明 `timeoutMs` 的任务不走本模块，仍为进程内执行（零开销）

## 使用场景中的写法

```ts
// src/tasks/slow-report/task.ts
export const task = { timeoutMs: 30_000 };
export function run(payload, taskCtx) {
  // 配合取消：上游调用携带 signal、长循环检查 signal.aborted，
  // 超时/停机时本任务在宽限期内自行退出，无需走到 terminate
  return fetch(url, { signal: taskCtx.signal });
}
```

隔离任务同样可访问 app 注册表（只读视图）——在 worker 线程内组装/调用 agent：

```ts
// src/tasks/log-analysis/task.ts
export const task = { timeoutMs: 30 * 60_000 };
export async function run(payload, taskCtx) {
  const agent = taskCtx.registries.agent.getAgent('log-analyzer');
  if (!agent) throw new Error('agent not registered');
  // 组装 agent 跑 LLM 循环（agent 元数据含 systemPrompt/tools/model 等）
  return analyzeAll(payload, agent);
}
```

组装完整 `AgentDeps`（含 `resolveToolSchema`）的示例见 [taskTypes.md](./taskTypes.md) 的「任务内组装 Agent」章节。

## 行为约定

- 执行：每次 dispatch 新建一个 worker（data URL wrapper 动态 import 任务产物模块）；worker 模块图独立——天然加载最新产物，dev 热替换后无需 cache-bust
- 取消（两段式）：超时（`timeoutMs`）或外部信号（驱动停机 abort）触发——先向 worker 发 abort 信号（任务监听 `taskCtx.signal` 可优雅退出），`KILL_GRACE_MS`（5s）内未退出则 `worker.terminate()` 硬杀；宿主侧 Promise 以超时错误 reject
- 超时判定即终局：宽限期内 worker 迟到的完成/错误一律忽略，不翻案
- 结果传导：worker 内 run 的返回值/抛错经 postMessage 回传；worker 顶层异常（如模块 import 失败）经 `error` 事件回传，均由语义层记 `failed` 并交驱动重试。**所有取消路径（超时终止/外部取消/宽限内结束）reject `TaskCancelledError`**——语义层据此把任务记录记为 `cancelled`（区别于 run 自身失败的 `failed`）
- `taskCtx.config` 为可克隆快照：structuredClone 优先，失败退化 JSON round-trip（丢函数字段），再失败传 `undefined`——任务收到的配置是纯数据
- `taskCtx.registries` 为注册表只读视图：宿主从 app 注册表生成 `TaskRegistriesSnapshot` 纯数据快照（agents 含 `filePath`/`hasRun` 完整元数据 + tools + skills）随 postMessage 传入，wrapper 内重建视图——注册表对象含函数闭包不可跨线程，元数据本身可克隆。**快照语义**：视图反映派发时刻的注册表（每次 dispatch 重新生成），执行中途的 reload/DB skill 变更不影响当次执行；`taskCtx.registries.agent.getAgentEntry(name)` 拿到的 `filePath` 为产物路径，worker 线程内可按需 import agent 产物执行 run
- 返回值必须可结构化克隆（纯数据）；不可克隆视为执行错误

## 边界取舍（文档必须显眼）

- **状态隔离**：任务文件的模块级变量每次执行都是新实例——run 内依赖的连接池/缓存需自建，不与进程内共享
- **硬杀副作用**：terminate 可能把事务/写操作砍在半路，由业务方幂等自担（与队列 at-least-once 语义一致）
- **冷启动开销**：worker 创建 + 模块加载为每次执行的固定成本，仅声明超时的任务承担

## 相关模块

- `src/task/taskQueue.ts` — 语义层按 `meta.timeoutMs` 路由到本执行器
- `src/task/driverTypes.ts` — externalSignal 来源（驱动停机 abort）
