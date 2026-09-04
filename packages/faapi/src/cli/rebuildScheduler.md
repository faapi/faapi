# rebuildScheduler

一句话概括：watcher 的重建调度器——debounce 合并文件事件、重建期间不重入（进行中的重建结束后自动补一轮）、编译失败时文件回灌待编译集合。

## 为什么需要

watcher 的重建链（增量编译 + compileConfig + reloadRoutes/reloadTools/reloadAgents）很容易超过 debounce 的 100ms 窗口。此前的实现只有 debounce、无重入保护：

- **重入竞态**：重建进行中再收到文件事件会并发触发第二个重建——并发写产物、`setLoadTimestamp` 与 registry 水合交错，导致 routes/tools/agents 状态不一致
- **失败丢文件**：待编译集合在编译前被清空，编译失败（如语法错误）后这批文件被丢弃，同批次的无关文件必须等下次修改才能重编译

调度器把「何时重建、重建哪些文件、重入如何处理、失败如何回灌」收敛为纯逻辑，chokidar 只是事件源。

## 使用场景

- `watcher.ts` 创建调度器，`add/change` 事件调 `addFiles([...])`，`unlink` 事件调 `schedule()`
- 重建回调封装「增量编译 → compileConfig → reloadRoutes/reloadTools/reloadAgents」

## 行为定义

- **debounce 合并**：窗口内的多次 `addFiles`/`schedule` 只触发一轮重建，回调收到累积的全部文件
- **重入保护**：重建进行中的事件只累积文件并标记「需要补一轮」；当前轮结束后自动补跑（带上重建期间累积的文件），补跑轮同样受保护，串行直到无待处理事件
- **失败回灌**：回调抛错时该轮文件合并回待编译集合，等待下一次文件事件一起编译；**不主动定时重试**——编译失败通常因语法错误，主动重试会造成每 100ms 一次的错误刷屏，用户保存修复文件后自然触发下一轮
- **成功清空**：回调成功后本轮文件清空，不回灌
- **空重建**：`schedule()` 无待编译文件时回调收到空数组（路由结构变化场景）

## 相关模块

- `watcher.ts` - 唯一消费方，chokidar 事件源 + 重建回调实现
- `compileDevRoutes.ts` - 重建回调的增量编译步骤（接收 `files` 参数）
- `compileConfig.ts` - 重建回调的配置重生成步骤（内部有 mtime 短路）
- `createDevApp.ts` - 重建回调的热替换步骤（reloadRoutes/reloadTools/reloadAgents）
