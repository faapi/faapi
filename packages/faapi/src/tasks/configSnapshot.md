# configSnapshot（隔离任务配置快照）

一句话概括：把宿主进程配置投影为可跨线程的纯数据快照（`collectConfigSnapshot`），供隔离任务（`worker.ts`）的 `taskCtx.config` 读取。

## 为什么需要

隔离任务与进程内任务对齐 config 能力：进程配置大部分是纯数据（端口、驱动选项、llms、业务自定义段），worker 内读不到只能靠 payload 手工搬运。但 config 整体不可结构化克隆——`app:*` / `task:failed` 事件订阅端、agent 工具钩子、log sink、middlewares、`extendContext` 等都是函数，函数闭包不可跨线程（与 registries 快照同款物理约束）。本模块把 config 投影为纯数据：**函数值不进快照（能力边界，非降级），其余值必须可克隆否则派发显式报错（fail fast，不静默剔除）**。

投影用 `structuredClone` 而非 JSON 序列化——JSON 会把 Date 变字符串、静默丢不可序列化字段；结构化克隆保真，Date/Map/Set 原样保留，数据字段与宿主所见逐值一致。

## 使用场景

- taskQueue 隔离派发前调用（每次 dispatch 重新投影——快照语义与 registries 快照一致，反映派发时刻的配置）
- 投影结果随 run 消息 postMessage 下发，worker 内作为 `IsolatedTaskContext.config` 注入

## 语义

- **函数值不进快照**：`typeof value === 'function'` 的属性（含嵌套）直接剔除——宿主侧回调/中间件/钩子是宿主行为面，worker 内不可调用，留在快照里只会造成"类型上存在、运行时不可用"的假象；symbol 值同理剔除。这是**显式声明的能力边界**（AGENTS.md 5.6.4 出口二），与 registries 快照"函数闭包不跨线程、纯数据元数据可过"同一口径
- **非函数不可克隆值显式报错**：Promise、WeakMap/WeakSet 等 `structuredClone` 无法处理且非函数的值 → `collectConfigSnapshot` 抛错并列出路径（如 `config.someField.promiseHolder`）——任务派发即失败，交驱动按 retries 重试；不剔除、不 warn-continue（出口一 fail fast）
- **其余值结构化克隆保真**：整体克隆成功直接返回（快路径）；失败则逐属性下探——对象/数组重建投影，Map/Set/Date/类实例等整体可克隆的子树原样保留（类实例经 structuredClone 退化为纯对象，与 registries 快照元数据同语义）
- 遍历走可枚举字符串键（`Object.entries`）；symbol 键属性不进快照

## 相关模块

- `src/tasks/taskQueue.ts` — 隔离派发时调用，结果经 `TaskWorkerOptions.taskCtx.config` 下发（消费方）
- `src/tasks/taskWorker.ts` / `src/tasks/workerEntry.ts` — run 消息携带、worker 内注入 `taskCtx.config`
- `src/tasks/taskTypes.md` — 两上下文差异表（config 行）
- `src/runtime/contextTypes.ts` — `FaapiContextConfig` 类型（快照的业务可见类型）
