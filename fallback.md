# fallback.md — 降级场景记录

DDD 规范要求：确有必须降级的场景（显式抛错会让业务完全不可用），在此留痕（场景 + 为什么必须降 + 降级后的实际行为 + 恢复条件）。未留痕的降级按静默降级处理。

## 任务 payload schema 缺失时跳过校验（taskQueue.validatePayload）

- **场景**：任务文件 `src/tasks/<name>/task.ts` 的 `run` 函数未声明 Payload 类型（或首参无类型名）时，`faapi build` / `faapi dev` 不会为该任务生成 `zod.js`，运行时 `enqueue` 无 schema 可用。
- **为什么必须降**：无类型声明即无校验契约是框架既有语义（路由 handler 无类型声明的方法不导出 Schema、tool 无 inputTypeName 跳过 schema）。任务 payload 属于进程内数据（不像 HTTP 请求来自外部），若强制要求类型声明，无参 cron 任务等合法场景将直接不可用。
- **降级后的实际行为**：`enqueue` 原样入队 payload，不做 zod 校验；有 `zod.js`（导出 `*Schema`）时才 safeParse，不合法抛 `ValidationError`。
- **恢复条件**：任务文件为 `run` 首参补充 interface 类型声明并重新构建/热重载，`zod.js` 生成后校验自动生效。
