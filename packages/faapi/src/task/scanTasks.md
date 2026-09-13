# scanTasks

一句话概括：扫描 `src/tasks/**/task.ts` 任务文件，零 import（读源码 + 正则提取 meta 字段），产出 TaskManifest[]。

## 为什么需要

与 scanRoutes / scanTools 同构——启动期只读源码不 import 模块（Vite 风格），保证冷启动快且不因任务代码错误阻塞启动清单生成。

## 使用场景

- `faapi dev` / `faapi build` 生成 `faapi-tasks.js` 清单前的扫描步骤
- dev watcher `reloadTasks` 重扫

## 行为约定

- 任务文件必须命名为 `task.ts`（与路由 `handler.ts` 对称），其他 .ts 文件跳过
- 任务名 = `tasks/` 后的目录路径段用 `.` 连接：`src/tasks/send-email/task.ts` → `'send-email'`；`src/tasks/a/b/task.ts` → `'a.b'`
- meta 字段从源码正则提取：`cron`（字符串字面量）、`concurrency` / `retries`（数字字面量）；未声明则缺省（undefined，运行时用默认值）
- 重名任务（不同文件推导出同名）抛错
- 目录下无任务文件时返回空数组

## 相关模块

- `src/tools/scanTools.ts` — 同构参照（patterns / 正则 / 重名检测）
- `src/cli/generateTaskArtifacts.ts` — 消费 TaskManifest[]
