# loadTaskDriver

一句话概括：按 `config.task.driver` 解析驱动——内置 memory 或动态加载 `@faapi/task-pgboss` / `@faapi/task-bullmq` 子包工厂，未知/未安装显式抛错。

## 为什么需要

主包不依赖任何外部驱动子包（零依赖核心），但 `createAppBase` 需要根据配置拿到驱动实例；动态加载 + 变量 specifier 让驱动真正可选（未安装不报错，配置了才解析）。

## 使用场景

- `createAppBase` 创建任务队列前调用一次
- 测试可传 TaskDriver 实例绕过加载

## 行为约定

- `undefined` / `'memory'` → memoryDriver；TaskDriver 对象 → 原样返回
- `'pgboss'` / `'bullmq'` → `import('@faapi/task-<name>')`，调用对应工厂并透传 `config.task.<name>` 选项
- 子包未安装 / 工厂导出缺失 / 未知 driver 名 → 抛错（含安装指引），不降级 memory

## 相关模块

- `src/task/driverTypes.ts` — TaskDriver / 工厂签名
- `src/cli/createAppCore.ts` — 调用方
