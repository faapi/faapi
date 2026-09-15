# fallback.md — 降级场景记录

DDD 规范要求：确有必须降级的场景（显式抛错会让业务完全不可用），在此留痕（场景 + 为什么必须降 + 降级后的实际行为 + 恢复条件）。未留痕的降级按静默降级处理。

## 任务 payload schema 缺失时跳过校验（taskQueue.validatePayload）

- **场景**：任务文件 `src/tasks/<name>/task.ts` 的 `run` 函数未声明 Payload 类型（或首参无类型名）时，`faapi build` / `faapi dev` 不会为该任务生成 `zod.js`，运行时 `enqueue` 无 schema 可用。
- **为什么必须降**：无类型声明即无校验契约是框架既有语义（路由 handler 无类型声明的方法不导出 Schema、tool 无 inputTypeName 跳过 schema）。任务 payload 属于进程内数据（不像 HTTP 请求来自外部），若强制要求类型声明，无参 cron 任务等合法场景将直接不可用。
- **降级后的实际行为**：`enqueue` 原样入队 payload，不做 zod 校验；有 `zod.js`（导出 `*Schema`）时才 safeParse，不合法抛 `ValidationError`。
- **恢复条件**：任务文件为 `run` 首参补充 interface 类型声明并重新构建/热重载，`zod.js` 生成后校验自动生效。

## 隔离任务错误的自定义属性不可克隆时丢弃 props（taskWorker）

- **场景**：worker 内 run 抛错的 Error 带自定义可枚举属性，其中含不可结构化克隆的值（函数、class 实例等）——如 `err.onRetry = () => {}`。
- **为什么必须降**：错误回传本身经 postMessage 结构化克隆，`props` 不可克隆会让 postMessage 抛 `DataCloneError`——若此时显式抛错，错误根本无法上报，宿主只能空等到 timeoutMs 才失败，比信息缺失严重得多。错误上报必须尽力送达。
- **降级后的实际行为**：丢弃 `props`（自定义属性），保底回传 `{ name, message, stack }`；宿主重建的 Error 仍有错误名、消息与 worker 侧堆栈，仅丢失不可克隆的自定义属性。
- **恢复条件**：业务错误类的自定义属性改为可克隆纯数据（字符串错误码 / 数字状态码而非函数、类实例），恢复全量保真。

## 隔离任务 config 含不可克隆字段时退化为 JSON 快照（taskWorker.safeConfig）

- **场景**：`faapi.config.ts` 全量配置经 postMessage 传入隔离 worker 时，含函数字段（如 lifecycle 钩子、自定义 `response.ok` 包装函数）——函数不可结构化克隆。
- **为什么必须降**：隔离任务必须拿到 config（业务方经 `taskCtx.config` 读取业务配置是基础能力），显式抛错会让任何含函数字段的配置（即所有声明了 lifecycle 钩子的项目）的隔离任务完全不可用。
- **降级后的实际行为**：三级探测——structuredClone 可克隆则原样传入；不可克隆退化 JSON round-trip（**丢函数字段、Date 变 ISO 字符串、Map/Set 丢失**，纯数据字段完整保留）；JSON 也失败（循环引用等）传 `undefined`。任务收到的 config 始终是纯数据快照。
- **恢复条件**：无——隔离线程的 config 只能是可克隆纯数据，属结构约束；业务方需将隔离任务依赖的可执行配置改为数据描述（如字符串枚举），任务内在 worker 侧自行映射行为。

## 日志 fields 不可序列化时降级为提示文本（logger 默认 console sink）

- **场景**：业务调用 `log.info(msg, fields)` 时 fields 含循环引用等 `JSON.stringify` 无法序列化的值。
- **为什么必须降**：日志是诊断手段，因一条坏 fields 抛错会中断业务请求/任务流程——"日志调用永不抛错"是日志器的基本契约，信息缺失远好于业务失败。
- **降级后的实际行为**：该条日志正常输出级别/scope/message，fields 部分替换为 `[unserializable fields: <错误原因>]` 提示文本；其余日志不受影响。自定义 sink 不受影响（序列化是默认 sink 的职责，自定义 sink 自行决定如何处理不可序列化值）。
- **恢复条件**：业务方修正 fields 中的循环引用/不可序列化值，该条日志即恢复完整 JSON 输出。

## 隔离任务日志 fields 不可克隆时丢弃 fields（taskWorker 内联日志桥）

- **场景**：隔离执行（声明 `timeoutMs`）的任务在 run 内调用 `taskCtx.log.info(msg, fields)`，fields 含函数、class 实例等不可结构化克隆的值。
- **为什么必须降**：worker 内日志条目只能经 postMessage 回传宿主输出（sink 闭包不可跨线程），fields 不可克隆会让 postMessage 抛 `DataCloneError`——若按执行错误处理（与 progress 同语义），一条日志的字段会终止整个任务执行，与"日志永不中断业务"的契约冲突。
- **降级后的实际行为**：丢弃 fields，条目保底 `level/message/scope/time` 照常回传输出，fields 替换为 `{ warning: 'log fields not cloneable across worker boundary, dropped' }` 标记（非静默）。进程内任务不受影响（无克隆边界）。
- **恢复条件**：业务方将 fields 改为可克隆纯数据（字符串/数字/普通对象），即恢复全量字段输出。



