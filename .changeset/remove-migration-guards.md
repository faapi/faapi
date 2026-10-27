---
'@faapi/faapi': minor
'@faapi/agent': minor
---

移除全部"检测到残留写法即抛错"的迁移护栏（维护者决策 2026-10-28，并追溯清理既有护栏）——残留旧写法改为静默无效或语言层 `TypeError`，类型层拒绝是唯一防线：

- `agent:root-input` 载荷 `input` 与 `agent:input` 载荷 `messages`：删除定制报错 setter，载荷字段变 getter-only——赋值抛 `TypeError`（只读语义不变，无迁移文案）。
- agent handler 导出 `run`：不再在启动期求值阶段抛错，`run` 导出被忽略（agent 恒为声明式执行，编排场景注册 tool）。
- 残留 `@tool` JSDoc 标签：不再在 schema 提取时抛 `SchemaExtractionError`，标签静默忽略，tool 名仍由目录路径 + 函数名推导。
- `task.driver: 'memory'`：删除专属迁移报错特判，落入未知驱动通用报错（`Unknown task driver "memory"`）。
- agent config 声明 `model`：文档口径修正——运行时本无检测，声明被忽略（类型上无此字段）。

> 版本策略留痕：本变更按语义属破坏性（依赖这些报错的升级检查流程会失效），沿 7.9.0 / 7.10.0 / 7.11.0 / 7.13.0 先例、经维护者指示（2026-10-28 会话）以 minor 随 7.x 线发布。

不受影响：构建期**功能校验**（`task.ts` 声明 `timeoutMs` / `graceMs` 的错位报错、`worker.ts` 缺 `timeoutMs` 必填报错、同目录两种任务文件并存的歧义报错、缺 `config` 导出报错、单 app 存活检测等）均为现行约定的一致性校验，维持不变。历史沿革见根目录 `HISTORY.md` 1.1 节。
