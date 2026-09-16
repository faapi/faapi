---
'@faapi/faapi': patch
---

修复 dev 模式下业务模块 `createLogger` 的输出不走 `config.log` 文件管道的问题（prod 不受影响）。

日志管道状态原为 logger 模块的模块级变量——dev 下 `faapi` CLI 跑在 `dist/cli/index.js`（tsup 内联框架代码），业务模块经包主入口加载 `dist/index.js`，两份副本 module cache 独立，导致 `configureLogging`（CLI 侧 `createAppBase` 调用）只作用于 CLI 副本，业务侧 `createLogger` / `flushLogging` 看到的 `fileSink` 恒为 null，`config.log.dir` 的业务日志退化为纯 console。管道状态改为 `globalThis` + `Symbol.for('faapi.logger.state')` 承载（与 `getApp` 单例同模式），跨模块实例共享，dev/prod 行为一致。
