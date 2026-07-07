---
"@faapi/faapi": minor
---

logger 中间件默认启用（与 cors 一致）

- `config.logger` 现在默认启用：`undefined` / `true` → 启用 `logger()`（console.log）
- `false` → 禁用内置 logger
- `LoggerOptions` → 启用并自定义（如传入 pino/winston logger 实例）
- 之前 `config.logger` 字段已声明但未消费（死字段），现在真正生效
- logger 中间件位置：CORS → helmet → logger → 全局中间件 → 目录中间件 → handler
- logger 中间件的 `log` 函数改为每次请求读取（`options.log ?? console.log`），运行时替换 `console.log` 会生效
- 完全自定义日志中间件：`logger: false` + `middlewares: [myCustomLogger]`
