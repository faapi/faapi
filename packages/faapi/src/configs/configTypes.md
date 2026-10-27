# configTypes

一句话概括：定义框架配置 FaapiConfig 的类型结构。

## 为什么需要

CLI 和 server 启动时需要统一的配置结构，包含根目录、app 目录、端口和路由模式等。集中定义确保 CLI 解析和 server 启动使用相同的配置格式。

## 使用场景

- CLI 参数解析后生成 FaapiConfig
- server 启动时读取 FaapiConfig
- 扩展点：`app:*` 流程事件（boot/ready/close 等，见 [appEventBus](../events/appEventBus.md)，配置上无钩子字段）、extendContext（扩展 ctx 方法）、cors（跨域配置）、helmet（安全头）、compression（响应压缩，gzip/deflate/br 协商，默认关闭）、etag（ETag/304 条件请求协商，默认关闭）、bodyLimit（请求体限制）、logger（结构化日志）、http2（HTTP/2 支持）、trustedProxy（是否信任反向代理的 X-Forwarded-For，默认 false）、middlewares（全局中间件）、injectors（全局注入器）、plugins（应用级插件）、agent（agent 子系统全局配置）

## agent 配置块（Phase 2.4）

`config.agent` 提供 agent 子系统的全局配置，所有字段均可选。无全局默认 agent / 默认 provider——`agent.run/stream` 每次调用必须显式传 `options.agent` 与 `options.model` / `options.provider`：

| 字段 | 类型 | 说明 | 默认值 |
| --- | --- | --- | --- |
| `llms` | `Record<string, LlmConfig>` | LLM provider 配置映射（嵌套级联：key 是 provider 名，值含 `models`）。plugin setup 时遍历调 `createProvider` 创建实例存 Map | `undefined`（外部 provider 模式，插件照常注册工厂） |
| `maxTurns` | `number` | 默认最大对话轮数，覆盖 agent 自身 `config.maxTurns`（agent 自身配置优先于全局） | `undefined`（用 agent 自身 maxTurns 或 Phase 3.x 默认值） |
| `maxAgentDepth` | `number` | agent 调用 agent 的最大递归深度（防护无限递归，Phase 3.3 reactLoop 使用） | `undefined`（Phase 3.x 用默认值，如 3） |

```ts
// faapi.config.ts
import type { FaapiConfig } from '@faapi/faapi';

export default {
  agent: {
    // LLM provider 配置（嵌套级联：key 是 provider 名，models 挂在该 provider 下）
    llms: {
      openai: {
        provider: 'openai',
        apiKey: process.env.OPENAI_API_KEY,
        baseURL: 'https://api.openai.com/v1', // 可选，默认 OpenAI 官方
        models: {
          'gpt-4o': {},                            // 用 provider 级默认
          'gpt-4o-mini': { temperature: 0.5 },     // 覆盖 temperature
        },
      },
      anthropic: {
        provider: 'anthropic',
        apiKey: process.env.ANTHROPIC_API_KEY,
        models: { 'claude-3-5-sonnet': {} },
      },
    },
    // 默认最大对话轮数（agent 自身 config.maxTurns 优先）
    maxTurns: 10,
    // agent 调用 agent 的最大递归深度（Phase 3.3 reactLoop 防护）
    maxAgentDepth: 3,
  },
} satisfies FaapiConfig;
```

**嵌套级联结构**：provider 在外层，model 在 `models` 下挂多个。provider 级字段（`apiKey` / `baseURL`）共享给所有 model；model 级字段在 `models[modelName]` 里覆盖。handler 通过 `agent.run(input, { agent: 'name', model: 'gpt-4o' })` 切换 model（详见 [agentHandle](../../../agent/src/agentHandle.md) 的 Run-level 覆盖优先级表）。

**优先级**：model 仅来自调用侧 `options.model` / `options.provider`（sub-agent 派发未声明 model 时沿用父调用解析结果）；`maxTurns` 取 agent 自身 `config.maxTurns`，未配置时用全局 `agent.maxTurns`。tool 引用列表只在每个 agent 自身的 `config.tools` 里显式声明。

**与 injectParams 的集成**：`@faapi/agent` 插件注册 agent handle 工厂，`agent` 参数注入 `AgentHandle`（含可调用 `run`）。调用时必须显式传 `options.agent` 指定 agent 名，不传抛 `AgentError`。



## 关键设计

- **统一响应格式**:框架内置 `config.response` 配置(`ok`/`fail` 可选),handler 直接 `return data` 时由 `invokeHandler.wrapResult` 自动用 `ok` 函数包裹(默认 `{ data }`),错误用 `ctx.fail({ status?, code?, message })` 返回(默认 `{ error: { message, ...code? } }`)。详见"统一响应格式"章节。
- **错误处理**:handler 抛错 → 框架内置 `formatErrorResponse(err)` 兜底 → 仍失败则最简 500 JSON 响应 → 响应发出后发射 `request:error` 事件（仅服务端故障 5xx——已处理 4xx 不发射,观察走请求日志 warn）。业务方如需自定义错误响应,在全局中间件中 try/catch `next()` 即可。
- **流程扩展经 app 事件承载，配置上无钩子字段**——由 [appEventBus](../events/appEventBus.md) 事件承载:`app:boot`/`app:ready`/`app:close`/`request:error`/`task:failed` + agent 域七事件。订阅入口唯一 `getApp().on(name, handler)`——启动期事件（`app:boot`/`app:ready`/`app:close`）写 `src/bootstrap.ts` 约定启动文件（框架在 app 创建后、listen 前加载执行,见 [bootstrap](../cli/bootstrap.md)）。`app:boot` 订阅端 handler 抛错 → `listen()` reject、端口不暴露。`LifecycleContext` 是 `app:*` 事件载荷类型。
- **LifecycleContext 携带 `config`**——faapi.config 全量配置的**活引用**,与请求 `ctx.config` / 进程内任务 `taskCtx.config` 同一对象。`app:boot`/`app:ready`/`app:close` 订阅端可直接读业务配置;`agent` 块复合形状经 `e.config.agent` 读回后可整体透传 `@faapi/agent` 的 `createAgentDeps({ agentConfig })`(详见 [agentDeps](../../../agent/src/agentDeps.md))——重启续跑等生命周期内组装 agent 的场景不再需要业务侧另立配置常量源。
- `agent.decorateDeps`:进程级 deps 配方装饰钩子——真实签名 `(deps: AgentDeps) => AgentDeps`(类型在 `@faapi/agent`,主包不反向依赖故按接受任意函数的手法声明,业务侧导入 `AgentDeps` 标注即强类型)。在 `createAgentDeps` 的 base 装配之上、显式 overrides 之前应用,插件注入的 AgentHandle 与业务自组装两路同源;典型用途:schema 富化包装(`resolveToolSchema`/`resolveAgentInputSchema`)、providers 进程级复用。配方抛错原样冒泡(不静默降级);请求级差异(`ctx`)不走本钩子。
- `extendContext(ctx)`:创建上下文后调用,用户可挂载自定义方法/属性到 ctx;配合 `declare module '@faapi/faapi'` 增强 FaapiContext 类型。（构造期装配,非流程监听——不事件化）
- `FaapiContextConfig`:空 interface,用户可通过声明合并增强 `ctx.config` 的类型。

## 统一响应格式(框架内置)

框架内置 `config.response` 配置(`ResponseConfig`),提供统一响应包装能力:

- **成功响应**:handler `return data`(非 Response,含 null/undefined)时,`invokeHandler.wrapResult` 自动用 `config.response.ok`(默认 `(data) => ({ data })`)包裹。`ctx.ok(data)` 显式包裹等价于 `return data`。
- **错误响应**:`ctx.fail({ status?, code?, message })` 返回错误 Response,用 `config.response.fail` 包装 body。
- **`Response` 对象**:原样透传,不被包裹(`ctx.ok`/`ctx.fail`/`ctx.json` 等返回的 Response 均属此类)。

**`error.code` 与 HTTP status 是两个独立维度,无关联**——HTTP status 表达错误大类(4xx/5xx),控制 HTTP 响应状态码;`code` 是响应 body 里的业务错误码字段,定位具体业务错误(如 `'USER_NOT_FOUND'`)。`ctx.fail()` 的 `status` 和 `code` 均可独立省略,无推导关系:

| 调用形式 | HTTP 状态码 | 响应 body |
| --- | --- | --- |
| `ctx.fail({ message })` | 500(默认) | `{ error: { message } }`(无 code 字段) |
| `ctx.fail({ status: 404, message })` | 404 | `{ error: { message } }`(无 code 字段) |
| `ctx.fail({ code: 'USER_NOT_FOUND', message })` | 500(默认) | `{ error: { code: 'USER_NOT_FOUND', message } }` |
| `ctx.fail({ status: 404, code: 'USER_NOT_FOUND', message })` | 404 | `{ error: { code: 'USER_NOT_FOUND', message } }` |

响应格式参考业界通用做法(Stripe / Facebook Graph / JSON:API):成功 `{ data: T }`、失败 `{ error: { code?, message } }`(与框架内置 `formatErrorResponse` 结构一致)。

```ts
// faapi.config.ts
import type { FaapiConfig } from '@faapi/faapi';

export default {
  response: {
    // 自定义成功包装(默认 (data) => ({ data }))
    ok: (data) => ({ code: 0, data }),
    // 自定义错误包装(默认:省略的字段不放入 error 对象)
    // 接收 { status?, code?, message },返回 body
    fail: ({ status, code, message }) => ({ error: { code, message } }),
  },
} satisfies FaapiConfig;
```

```ts
// api/user/handler.ts
export interface User { id: number; name: string }

// 成功响应:直接 return data,框架自动包裹
export function GET(): User {
  return { id: 1, name: 'Alice' };
  // 响应: { data: { id: 1, name: 'Alice' } }
}

// 错误响应:ctx.fail 返回 Response,不被包裹
export function POST(ctx, body: { name: string }) {
  if (!body.name) {
    return ctx.fail({ status: 400, code: 'NAME_REQUIRED', message: 'name is required' });
    // 响应: HTTP 400, { error: { code: 'NAME_REQUIRED', message: 'name is required' } }
  }
  return { created: true };
}
```

**自定义错误响应**:用全局中间件捕获 handler 抛错:

```ts
// faapi.config.ts
import type { FaapiMiddleware } from '@faapi/faapi';
import { ValidationError } from '@faapi/faapi';

const errorHandler: FaapiMiddleware = async (ctx, next) => {
  try {
    await next();
  } catch (err) {
    if (err instanceof ValidationError) {
      // 与框架 formatErrorResponse 格式一致:code 用框架字符串错误码
      return ctx.json(
        { error: { code: err.code, message: err.message, issues: err.issues } },
        err.statusCode,
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    return ctx.fail({ message });  // status 省略默认 500,code 省略 body 里无 code 字段
  }
};

export default {
  middlewares: [errorHandler],
} satisfies FaapiConfig;
```

## 相关模块

- `loadConfig.ts` - 运行时从 `faapi-config.js` 产物读取配置
- `compileConfig.ts` - 编译阶段合并 env 配置生成 `faapi-config.js`
- `createAppCore.ts` - 使用配置启动 server
- `createContext.ts` - 调用 extendContext 扩展 ctx
