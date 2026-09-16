# logger

一句话概括：框架级结构化日志器——带级别（debug/info/warn/error）、scope 分类、结构化字段与可插拔 sink 的 `createLogger` 工厂，注入 handler（`ctx.log` / 参数 `log`）、任务（`taskCtx.log`）与任意业务代码，全局行为由 `config.log` 配置。

## 为什么需要

框架此前只有请求日志中间件（`middleware/logger.ts`，记录 method/path/status/duration）：业务代码（handler、中间件、任务、lifecycle 钩子）要输出自己的日志只能裸用 `console.log`——无级别过滤（生产想关 debug 只能改代码删语句）、无分类（海量日志分不清来自哪个模块）、无结构化字段（接日志采集系统要自己拼 JSON）、无法统一替换输出目标（写文件/接 pino 要各处手写）。参考 NestJS（内置 Logger 的级别过滤与 context 分类、`useLogger` 替换实现）与 Fastify（`request.log` 请求级 child logger 自动绑定 requestId）补齐这一层：**零依赖内核 + 可插拔 sink**——默认输出到 console（开箱即用），业务可整体接管（接 pino/winston/文件），不引入任何日志库依赖。

## 使用场景

### 1. 任意位置创建分类日志器（模块顶层 / 工具函数内）

```ts
import { createLogger } from '@faapi/faapi';

const log = createLogger('db');

export async function connect() {
  log.debug('connecting', { host });           // console 出口默认 info 级,debug 不显示（文件/sink 出口不过滤）
  await pool.connect();
  log.info('db connected', { host, port });
  try {
    migrate();
  } catch (err) {
    log.error('migration failed', { error: err }); // Error 值自动展开 name/message/stack
    throw err;
  }
}
```

### 2. handler 内用请求级日志器（`ctx.log` / 参数注入 `log`）

`ctx.log` 是每请求自动创建的 child logger：scope `http`，字段自动携带 `requestId`/`method`/`path`，业务日志与请求日志可通过 requestId 关联：

```ts
export function GET(ctx) {
  ctx.log.info('listing users');               // 自动带 requestId/method/path 字段
  return listUsers();
}

// 或参数名注入（与 tasks/agent 同机制）
export function POST(log, body) {
  log.warn('slow import requested', { rows: body.rows.length });
  return { queued: true };
}
```

`ctx.requestId` 同步暴露：优先取请求头 `x-request-id`（逗号分隔取第一段，网关透传场景跨服务串联），无则 `crypto.randomUUID()` 生成。

需要更细分类时从 `ctx.log` 派生 child（scope 合并为 `http:user`，requestId 等字段继承）：

```ts
ctx.log.child('user').debug('cache miss');     // [ISO] DEBUG [http:user] cache miss {"requestId":...}
```

### 3. 任务内记录日志（`taskCtx.log`）

```ts
// src/tasks/settle-payment/task.ts
export async function run(payload, taskCtx) {
  taskCtx.log?.info('settling', { orderId: payload.orderId }); // 自动带 jobId/task/attempt 字段
}
```

进程内执行与隔离执行（声明 `timeoutMs` 的任务）行为一致：隔离路径下日志条目作为纯数据经 postMessage 回传宿主、由宿主统一的 sink 输出——自定义 sink 同样覆盖隔离任务。宽限期（取消判定后）产生的日志与进度同语义：不采纳（超时判定即终局）。

### 4. egg 风格文件输出（`config.log.dir`，一条配置得文件日志）

传统部署按文件采集日志、error 需要单独文件盘查的场景，不需要手写 sink——配置 `dir` 即启用内置文件管道（详见 `fileSink.md`），且**请求日志自动并入同一管道**（一份配置管全部输出）：

```ts
// faapi.config.ts
export default {
  log: {
    dir: 'logs',           // logs/app.log 全量 + logs/error.log 仅 error（egg dup 语义）
    // splitByLevel: true, // 或按级别四文件：debug.log / info.log / warn.log / error.log
    // stdout: true,       // 默认写文件同时保留 console；false 纯文件
  },
} satisfies FaapiConfig;
```

文件出口**未显式配置 `level`（含 `LOG_LEVEL` env）时不过滤**——全量条目落盘，debug/info/warn/error 的分流由文件布局决定（`splitByLevel`），不在管道层丢数据；显式配置 `level` 时文件出口阈值生效。console 出口独立由 `consoleLevel` 控制（默认 `'info'`），与文件阈值互不牵扯。

### 5. 接管输出目标（业务方接入 pino / 写文件）

框架**不内置 pino**（不新增依赖、不代替业务选型）——`config.log.sink` 就是业务方接入 pino 的官方入口，一次赋值完成整条管道接管（`ctx.log` / `createLogger` / `taskCtx.log` 全部走 sink，隔离任务也覆盖）：

```ts
// faapi.config.ts
import pino from 'pino';
import type { LogEntry } from '@faapi/faapi';

// pino 级别放到最低；需在 faapi 侧降噪时显式配 config.log.level（管道阈值,不配不过滤）
const pinoLogger = pino({ level: 'trace' });

// entry.fields 里的 Error 是原始实例（Error 展开是默认 console sink 的职责），
// 自定义 sink 自行序列化——用 pino.stdSerializers.err
const serializeFields = (fields: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(fields).map(([k, v]) => [k, v instanceof Error ? pino.stdSerializers.err(v) : v]),
  );

export default {
  log: {
    sink: (entry: LogEntry) => {
      pinoLogger[entry.level](
        { scope: entry.scope, ...(entry.fields ? serializeFields(entry.fields) : {}) },
        entry.message,
      );
    },
  },

  lifecycle: {
    // pino 默认 sync:false 异步缓冲，优雅停机时 flush（faapi 收到 SIGTERM 自动走 onClose）
    onClose() {
      pinoLogger.flush();
    },
  },
} satisfies FaapiConfig;
```

注意点：

- **级别过滤归属**：管道阈值 `level` 不配时不过滤——pino 收到全量条目,降噪交给 pino 自身 level 或显式 `config.log.level`（避免双重过滤配置漂移）
- **请求日志统一进 pino**（缺省即并入）：请求日志无条件走统一管道（scope `access`）,sink 接管后自动覆盖；需自定义格式时用 `middlewares: [logger({ log: (entry, msg) => ... })]` 自行组装
- **绝对不丢日志**（审计类）：`pino(pino.destination({ sync: true }))` 同步写，牺牲吞吐换确定性；常规场景默认异步 + `onClose` flush 足够
- 本地开发美化输出：`pino({ transport: { target: 'pino-pretty' } })`（需安装 pino-pretty）或命令行管道 `node dist/main | npx pino-pretty`；`transport` 模式下进程退出前用 `pino.final` 处理 flush，不影响容器内的 JSON 采集

## 与 Docker 配合

日志能力按 12-factor 设计，容器场景零改造：

- **输出到 stdout/stderr**：默认 console sink 的 debug/info 走 stdout、warn/error 走 stderr，`docker logs` 直接可见；容器内**不写日志文件**，采集交给 Docker logging driver（json-file / fluentd / loki 等）或 k8s 采集器
- **结构化采集**：接 Loki/ELK/Datadog 时按上一节接 pino sink——JSON 行到 stdout，单流（pino 不像默认 console 分流 stderr）对采集器更友好；`requestId` 已在每条业务日志与请求日志条目中，跨服务串联可用，多副本部署可在 sink 里补 `hostname` 等 Pod 维度字段
- **级别调整不改镜像**：`docker run -e LOG_LEVEL=debug`（compose `environment:` / k8s `env` 同理）。faapi 的 `loadEnv` 也会把镜像内 `.env` 加载进 `process.env`，但运行期注入用 `-e` 最常见。注意优先级：`config.log.level` 显式值 > `LOG_LEVEL` env > 不过滤——容器场景建议 config 只写 `sink` 不写死 level，级别交给环境变量
- **优雅停机不丢日志**：`docker stop` 发 SIGTERM → faapi（listen 时已注册 SIGTERM/SIGINT handler）自动优雅关闭——drain 在跑任务、执行 `lifecycle.onClose` 后退出 → pino 的 flush 挂在 `onClose`（见上节示例）；Docker 默认 10s 宽限期足够，超时 SIGKILL 强杀时异步缓冲仍可能丢（同所有 Node 进程）

```yaml
# docker-compose.yml 示例
services:
  api:
    build: .
    environment:
      - PORT=3000
      - LOG_LEVEL=info        # 级别运行期可调，无需改镜像
      - NODE_ENV=production
    # logging driver 按需选配（默认 json-file）
    # logging:
    #   driver: loki
```

`log: false` 完全静默（含 error 与请求日志，测试场景降噪）；`log` 未配置或 `true` 时 console 输出（`consoleLevel` 默认 `'info'`），管道阈值取 `config.log.level` > 环境变量 `LOG_LEVEL` > 不过滤（非法值启动报错，不静默兜底）。日志全局配置是**进程级资源**（stdout/文件本就进程唯一）：多 app 同进程时后启动的 app 覆盖先启动的，与注册表的 app 实例级隔离不同。

**全局状态跨模块实例共享（globalThis 承载）**：管道状态（level/sink/fileSink 等）存在 `globalThis` 上（`Symbol.for('faapi.logger.state')` 键，与 `getApp` 单例同模式），不放在模块级变量里。原因：dev 模式下日志管道存在两个模块实例——`faapi` CLI 跑在 `dist/cli/index.js`（tsup 打包时内联了框架代码），业务模块经包主入口加载 `dist/index.js`，两份副本各有独立 module cache；`configureLogging` 由 CLI 侧的 `createAppBase` 调用，若状态是模块级的，业务代码 `createLogger`（走主入口副本）看到的 `fileSink` 恒为 null，日志退化为纯 console——dev 下 `config.log.dir` 的业务日志全部不落盘（prod 的 `dist/main` 与业务模块共享 `dist/index.js` 同一实例，不受影响）。globalThis 键用 `Symbol.for` 创建，跨副本命中同一个 key；prod 行为无变化。

### 默认文本格式

```
[2026-09-15T08:00:00.000Z] INFO [db] connected {"host":"localhost"}
[2026-09-15T08:00:00.000Z] DEBUG [http] listing users {"requestId":"...","method":"GET","path":"/api/users"}
```

`[ISO 时间] LEVEL [scope] message fields-JSON`，scope/fields 缺省时对应段省略。级别映射 console.debug/info/warn/error（warn/error 走 stderr）。fields 中的 `Error` 值序列化为 `{ name, message, stack }`。

### 与请求日志中间件的关系

**egg 模型：请求日志无条件并入统一管道**（`config.logger` 独立配置已废除，`config.log` 是唯一日志配置入口）：

| 配置 | 请求日志行为 |
|------|------|
| 缺省 | **并入管道**：条目 `{ level: 2xx/3xx→'info'、4xx→'warn'、5xx→'error'，message: 'GET /api/users 200 12ms'，scope: 'access'，fields: { requestId, method, path, status, durationMs, error? } }`——与业务日志同文件/同 sink/console，`level`/`consoleLevel` 统一过滤 |
| `accessLog: false` | 关闭请求日志（不输出） |
| `config.log: false` | 全静默，请求日志一并关闭 |

scope `access` 与业务日志的 `http` 区分，`requestId` 关联两者；文件模式下 5xx 自动进 `error.log`。需要完全自定义输出格式时用 `logger({ log })` 中间件自行组装（见 `../middleware/logger.md`），不再走管道。

## 行为约定

- **双出口独立阈值（egg transport 模型）**：一条管道、两个输出出口，各管各的阈值——`level` 管管道出口（文件/sink 收到的条目，不配**不过滤**，全量放行）；`consoleLevel` 管 console 出口（不配 `'info'`，`false` 关闭）。两者互不牵扯：文件可 `level: 'error'` 只存错误，console 可 `consoleLevel: 'info'` 看全
- **级别常量**：`debug(0) < info(1) < warn(2) < error(3)`
- **级别解析**：logger 实例级 `options.level` 是该实例的入口预滤（低于阈值不构造条目）；全局 `level` 取 `config.log.level` 显式值 > `LOG_LEVEL` 环境变量 > 不过滤。非法级别（config 或 env）在 `configureLogging` 时显式抛错（启动期 fail fast），不降级为默认值
- **出口解析**：logger 实例级 `options.sink` 优先（显式接管，不受全局 `log: false` / 出口阈值影响）→ 全局 sink（受 `level`）→ 文件管道（`dir`，受 `level`；`stdout` 非 false 时 console 双写，受 `consoleLevel`）→ 纯 console（受 `consoleLevel`）。`sink` 与 `dir` 互斥，同时配置抛错
- **`child(scope)`**：scope 以 `:` 合并（`createLogger('http').child('user')` → `http:user`，可多层嵌套），fields 浅合并（child 覆盖同名键）；返回新 Logger，父子互不影响
- **`configureLogging(undefined)`** 重置为默认（管道不过滤、consoleLevel 默认 info、无文件/自定义 sink）——编程式多 app 切换全局配置用
- 日志调用**永不抛错**：fields 序列化失败（循环引用等）降级为提示文本输出（已记入 `fallback.md`），不影响业务流程

## 相关模块

- `loggerTypes.ts` - `LogLevel`/`LogEntry`/`LogSink`/`Logger`/`LogConfig` 类型契约
- `fileSink.ts` - egg 风格文件输出 sink（`config.log.dir`，含 `splitByLevel` 分级文件）
- `formatEntry.ts` - 默认文本格式化（console 与文件共用）
- `runtime/createContext.ts` - 每请求创建 `ctx.requestId` + `ctx.log`
- `runtime/contextTypes.ts` - `FaapiContext.requestId`/`FaapiContext.log` 字段声明
- `injection/injectParams.ts` + `injection/resolveInjection.ts` - 参数名 `log` 注入 `ctx.log`
- `task/taskQueue.ts` - 进程内任务注入 `taskCtx.log`
- `task/taskWorker.ts` - 隔离任务的内联日志桥（postMessage 回传宿主）
- `cli/createAppCore.ts` - `createAppBase` 读 `config.log` 调 `configureLogging`；`log` 列入内置 config key
- `middleware/logger.ts` - 请求日志中间件（`accessLog` 并入统一管道，scope `access`）
- `config/configTypes.ts` - `log?: LogConfig | boolean` 配置项
