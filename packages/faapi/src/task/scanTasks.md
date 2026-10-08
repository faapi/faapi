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
- meta 字段从源码正则提取字面量：`cron`（字符串字面量）、`concurrency` / `retries` / `timeoutMs` / `graceMs`（数字字面量，支持下划线分隔 `60_000`）；未声明则缺省（undefined，运行时用默认值）
- **meta 值必须是纯字面量**——零 import 扫描不做表达式求值，表达式（`30 * 60_000`）与动态值（`Number(process.env.X)`）不支持
- **字面量守卫（构建期报错，不降级）**：声明了 meta 字段但值不是可识别字面量时，扫描期抛错（逐字段列出后果与修复指引）——`timeoutMs` 被忽略会让任务悄悄从隔离执行退化进程内（无超时无真终止且无信号），「警告后忽略」仍是声明失效的降级，契约缺失必须在扫描期显式失败。判定：非注释行内的 `字段名:` 宽松检测（不锚行首，单行对象写法也能命中）与严格字面量正则（行首锚提取）求差集；行注释（`// timeoutMs: ...` 示例）与块注释行（`*` / `/*` 开头、`*/` 结尾）跳过不误报；残余误报面为单行块注释内嵌 meta 形样的文本（如 `/* cron: '0 3 * * *' */`）——报错信息含此提示，改写注释即可解除
- 重名任务（不同文件推导出同名）抛错
- 目录下无任务文件时返回空数组
- 返回结果按任务名字母序排序（与路由清单 `sortRoutes` 的字母序对称）——fast-glob 不保证文件顺序，排序保证 `faapi-tasks.js` 产物内容确定、断言稳定

## 相关模块

- `src/tools/scanTools.ts` — 同构参照（patterns / 正则 / 重名检测）
- `src/cli/generateTaskArtifacts.ts` — 消费 TaskManifest[]
