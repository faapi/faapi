# loadTaskDriver

一句话概括：按 `config.task.driver` 解析驱动——动态加载 `@faapi/task-pgboss` / `@faapi/task-bullmq` 子包工厂或透传自定义 TaskDriver 实例，未配置/未知/未安装显式抛错。

## 为什么需要

主包不依赖任何外部驱动子包（零依赖核心），但 `createAppBase` 需要根据配置拿到驱动实例；动态加载 + 变量 specifier 让驱动真正可选（未安装不报错，配置了才解析）。任务队列不再提供内置内存实现——持久化/外部驱动是任务子系统的唯一承载方式。

## 使用场景

- `createAppBase` 创建任务队列前调用（仅当存在任务清单时）
- 测试 / 编程式场景可直接传 TaskDriver 实例（透传返回）

## 行为约定

- `undefined` → 抛错（提示配置 `config.task.driver` 与安装子包）
- `'memory'` → 抛错（内置内存驱动已移除，含迁移指引）
- TaskDriver 对象 → 原样返回
- `'pgboss'` / `'bullmq'` → `import('@faapi/task-<name>')`，调用对应工厂并透传 `config.task.<name>` 选项
- 子包未安装 / 工厂导出缺失 / 未知 driver 名 → 抛错（含安装指引）

## 相关模块

- `src/task/driverTypes.ts` — TaskDriver / 工厂签名
- `src/task/idleTaskDriver.ts` — 无任务清单时的占位驱动（不走本模块）
- `src/cli/createAppCore.ts` — 调用方
