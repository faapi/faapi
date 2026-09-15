---
'@faapi/faapi': patch
---

补上 `flushLogging` 主入口导出：6.9.0 的 changeset 声明"公开导出 flushLogging"，但实现只在 `logger/logger.ts` 模块内导出、漏加 `src/index.ts` 主入口——发布包 `import('@faapi/faapi')` 上 `flushLogging` 为 `undefined`，`lifecycle.onClose` 刷盘不可用。本次补齐导出并新增主入口导出防回归测试（`src/index.test.ts`）。
