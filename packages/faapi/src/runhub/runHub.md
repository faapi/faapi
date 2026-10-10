# runHub（createRunHub）

一句话概括：交互式 run 的传输中枢——「run 与 HTTP 解耦 + 订阅式消费」的原语，框架拥有运行生命周期、缓冲重放、实时扇出、中止，业务通过泛型（K=业务键、E=业务事件载荷）与可选持久化 SPI 接入自己的键、事件与存储。

## 为什么需要

流式 agent 产品（POST run 立即返回、服务端常驻跑完、任意连接订阅同一运行）都需要同一套传输机械：运行态管理、中途进入的缓冲重放、多订阅者扇出、冲突防护、中止。没有框架原语时每个项目手搓一遍（业务实证：188 行传输核 + 同拍快照/finish 即清/溢出标记等语义纪律，每项目各自踩竞态坑）。

与 `tasks.subscribe` 任务事件通道的分工：任务通道面向后台任务事件（落库后可查历史），runHub 面向「进行中一轮」的实时流 + 中途进入重放——硬套任务通道会把流式 delta 写库（违背落库时机=结束态的既定纪律）。

## 使用场景

- 交互式 agent 会话：`chat/<id>/run` 端点 `start(key)` 拿 handle 挂到 LLM 流式回调，`chat/<id>/subscribe` 端点（SSE/WS 均可挂）订阅同一 key；刷新页面 / 多 tab 打开时新连接经 subscribe 快照拿到已发生事件并实时接续
- 停止：`abort(key)` 触发 `handle.signal`，业务把它接到 LLM 请求的 AbortSignal（既有 `AgentAbortError` 链路）
- 轮外直播：`publishExternal` 绕过缓冲直扇当前订阅者（后台产线向对话直播过程事件），在线即见、刷新即失

## 语义契约

| 项 | 语义 |
| --- | --- |
| 冲突 | 同键 running 期间再 `start` 抛 `RunConflictError`（`FaapiError` 子类，`code='RUN_CONFLICT'`、`statusCode=409`，逃逸到 HTTP 管线时自动格式化为 409）——写路径串行是交互式 run 的默认正确语义 |
| 快照同拍 | `subscribe` 同步返回：注册订阅者与缓冲快照在同一同步执行内完成，重放与实时无缝衔接（单进程内无插队），无缺口无重复 |
| finish 即清 | 缓冲只服务「进行中一轮」；业务定稿持久化**先于** `finish()` 调用，`finish` 清运行态与缓冲；此后 handle.publish 自然空操作；完结轮不从内存重放（订阅端以库为准——`runId: null` 即无进行中 run） |
| seq | 每键严格单调递增、跨 run 不清零，基座为键首次触碰时刻的毫秒时间戳（Redis Streams 同款方案——跨 hub 进程不碰撞，`sinceCursor` 游标与 store 重放去重依赖这一性质）；消费端按不透明单调序号对待，不做数值假设。`publishExternal` 事件恒 `seq=0` 且不进缓冲不进存储 |
| 溢出 | 缓冲超 `maxBuffer` 丢最旧并置 `truncated=true`（该轮持续为 true），订阅端据标记回落业务对账——不静默 |
| 中止 | `abort(key)` 触发 `handle.signal` 并返回 true；不自动 finish——业务接 signal 取消 LLM → 收尾持久化 → 自行 `finish()`；无进行中 run 返回 false |
| 心跳/传输 | hub 是 K→订阅回调的扇出点，不管连接——SSE/WS 挂接与通道侧心跳是端点层配方，hub 不耦合传输形态 |
| 订阅者生命周期 | 订阅者跨轮长存（空闲连接等下一轮 start）；先于 run 订阅能收全该轮；`unsubscribe` 后不再收；单订阅者回调抛错 `console.error` 留痕不拖累他人（同任务事件扇出先例） |
| 默认形态 | 无 persistence、`replayPolicy: 'inflight-only'` 时为纯内存实现——缺省行为即本表全部语义，不依赖任何外部存储 |

## 持久化 SPI（可选，多实例演进位）

`persistence` 未提供 = 纯内存；提供时 `publish` 逐事件调用 `append(key, event)`（key 以字符串形式传入），`subscribe` 支持 `sinceCursor` 增量：重放改走 `loadSince(key, cursor)`（返回按 seq 升序），跨重启/多实例由业务存储承接。

- **store 重放路径的统一口径**：`sinceCursor` 提供或 `replayPolicy: 'always'` 时，subscribe 返回的 `events` 恒为空数组、`truncated` 恒 false（两者只描述内存缓冲快照），全部事件（store 重放 + 实时）经 `onEvent` 按 seq 有序去重送达——重放期间发布的实时事件排队，重放批之后按到达序送达（`seq=0` 的外部事件不去重、排在重放批之后）
- `sinceCursor` 提供但未配置 persistence → 显式抛错（不静默忽略）；`replayPolicy: 'always'` 未配置 persistence → `createRunHub` 构造期抛错
- **append 失败是持久化旁路失败，不杀死直播主流程**：同步抛错与 Promise rejection 均不传播出 publish，每 hub 实例首次失败 `console.error` 留痕（异步 append 成功后复位，再次失败重新留痕）——存储宕机时实时流照常、重放能力退化为业务可见（禁降级出口三：留痕不改主流程）；`loadSince` 失败同理：该次重放放弃（留痕），排队事件照常送达，实时接续
- 摘要式取舍：store 重放（`always`/`sinceCursor`）时订阅端拿的是业务存储的全量真相，内存缓冲的 truncated 语义不适用（恒 false）；缓冲溢出对账仍是 `inflight-only` 纯内存路径的契约

## 相关模块

- `../errors/FaapiError.ts` - `RunConflictError` 基类（409 错误响应自动格式化）
- `../task/taskTypes.ts` 的 `TaskEvent` - 任务事件通道（后台任务观测面，与本原语分工见上）
- `../../agent/src/agentHandle.md`（`@faapi/agent`）- 典型消费方：run handle.signal 接 `agent.run` 的 abort 链路
